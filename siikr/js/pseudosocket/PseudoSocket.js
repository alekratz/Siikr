const getPotentiallySharedWorker = function (url) {
    if (window.SharedWorker != null) {
      return new SharedWorker("js/pseudosocket/eventSourceWorker.js?v=" + scriptVersion);
    } else {
      var worker = new Worker("js/pseudosocket/eventSourceWorker.js?v=" + scriptVersion);
      worker.port = worker;
      return worker;
    }
  }
  
  /**
   *
   * @param {string} eventSourceURL - OPTIONAL the url to listen on for messages from the server.
   * If unspecified, a default will be used.
   * @param {int} registrationStringLength OPTIONAL a number indicating how long the registration string can be 
   * before listeners which specify themselves as removable start getting removed. 
   */
  function PseudoSocket(eventSourceURL, registrationStringLength) {
    var tagDelimiter = " !!TD!! ";
    var workerService = getPotentiallySharedWorker("/js/pseudosocket/eventSourceWorker.js?v=" + scriptVersion);
    var eventsrc_url = eventSourceURL;
    var responseTagCallbackMap = {};
    var regLength = 25000;
    this.isConnected = false;
  
    window.addEventListener(
      "beforeunload",
      event => {
        workerService.port.postMessage({ close: true });
      },
      true
    );
    window.addEventListener(
      "unload",
      event => {
        workerService.port.postMessage({ close: true });
      },
      true
    );
    if (eventSourceURL == undefined) {
      eventsrc_url = "../../routing/serverEvents.php";
      //window.location.protocol + window.location.hostname + "../../php/serverEvents.php";
    }
  
    /**
     * For each element on a page you want to receive updates on,
     * register the element with this function.
     *
     * Each element should provide this function the following information:
     *
     * @param {string} eventPattern - The eventPattern it wants to be notified about
     * @param {object} queryObject - A queryObject requesting that the server query for additional data before responding.
     * @param {function} callback - A callback function to execute when the event occurs.
     *
     * Things to note about each parameter:
     *
     * 1. The `eventPattern` parameter is ideally a string identical to any of those generated by the `w_` functions the server sends out
     *     whenever it makes a table modification).
     *      -as a convenience, providing the `eventPattern` parameter a string ending in `*`
     *       will be interpreted to mean "notify me of any eventPattern that starts with the string
     *       before the wildcard, I don't care about the contents of the rest of the eventPattern."
     *       However, be mindful that this doesn't imply any support for regular expression
     *       matching. The `*` is only operationally meaningful when it is the last character in the string.
     *       Its inclusion anywhere else in the string will be interpreted in the literal sense.
     * 2. The server's response will include the result of the query specified by the `queryObject` in an object with the key `queryResult`.
     *         - A `queryObject` must be of the following form:
     *           {
     *              `queryFunction`: {string}, - the name of the serverside function for serverEvents.php to call
     *              `params`: {key-value pairs} - the parameters to the function.
     *                                          - Note that these parameters can operate on variables contained in the eventMessage.
     *                                          -For example, if you know that the event you're listening for includes an `eventMessage` of the form
     *                                            {`target_id` : 15, `description` : 'hello there'},
     *                 then by specifying a `params` object of the form
     *                      {`id` : 'message.target_id',
     *                      `desc`: 'message.description'}
     *                 You would be specifying that the queryFunction should be provided
     *                      {`id` : 15,
     *                      `desc`: 'hello there'}
     *           }
     * 3. The callback function should accept an event object. This object will be a JSON object of the following form
     *        {
     *          `errorStatus`: {string}, - either "FALSE: " or "SUCCESS" if your query was successfully executed,
     *                          or the error message resulting from its failure.
     *          `eventMessage` : {object}, the JSON object the server fired accompanying the eventPattern
     *          `eventPattern` : {string}, - the eventPattern that triggered this event (as listened for by this listener)
     *          `eventBroadcast` : {string}, - the full eventPattern that triggered this event (as sent by the server) 
     *          `formattingStatus` : {string}, - will contain "Well formed" if your queryObject was formatted correctly,
     *                          or some error if it wasn't.
     *           `queryObject`:   {object} - the queryObject this listener was initialized with,
     *           `queryResult` : {object} - A JSON object (potentially containing other JSON objects) containing
     *                           the results of your query.
     *           `responseTag` : {string} - Ignore this. It's behind-the-scenes stuff used to avoid crippling the server.
     *        }
     */
  
    this.addServerEventListener = (eventPatt, queryObject, callback) => {
      //Two components listening for the same pattern should only receive
      //the same message if they are also expecting the same query result,
      //so the following generates a tag concatenating the eventPattern
      //with the query to ensure that the eventSource notifies the correct update
      //handler, and to ensure that the update handler notifies the correct component.
      //if the active eventsource is already listening for that
      //responsetag, it avoids creating a new event source object
      //
      //additionally, a list of responsetags which have been unregistered is 
      //maintained up until the next reconnect, so that if an element decides to stop 
      //listening, and then start listening again, no disconnect or reconnect is required.
      eventPatt = eventPatt.endsWith("*")
        ? eventPatt.substring(0, eventPatt.length - 1)
        : eventPatt + " ";
  
      var qString = JSON.stringify(queryObject);
      var responseTag = eventPatt + tagDelimiter + qString;
      var queryObject = JSON.parse(qString); //clone to make sure we don't mess with original data.
  
      if (responseTagCallbackMap[responseTag] != undefined) {
        var eventObj = responseTagCallbackMap[responseTag];
        if (eventObj.callbacks.indexOf(callback) == -1)
          eventObj.callbacks.push(callback);
      } else {
        responseTagCallbackMap[responseTag] = {
          eventPattern: eventPatt,
          queryObj: queryObject,
          callbacks: [callback]
        };
        //var reqLength = this.getRequestLength();
  
        //since we will need to reconnect to send the new listener array.
        //we only do the reconnection procedure if we're already connected.
        //if (othis.isConnected) {
        this.graceTimer.connectSoon();
        //}
      }
    };
  
  
    this.getRequestLength = () => {
      var fullString = "";
      for (var k of Object.keys(responseTagCallbackMap)) {
        fullString += k;
      }
      return fullString.length;
    }
  
    /**
     * Convenience function for items that change
     * what events they want to listen for. Call this
     * to remove a previously registered callback
     * by providing the callback, eventPattern, and queryObject
     * being triggered / listened for / requested. 
     * 
     * If no eventPattern is provided, this function will remove all instances of the callback 
     * for any eventPatterns in which it appears. 
     * 
     * if no queryObject is provided, this function will remove all instances of the callback
     * for all eventPatterns in which it appears.
     */
    this.removeClientSideEventListener = (callback, eventPattern, queryObject) => {
      /*var reconnect = this.getRequestLength() > this.regLength;
      if(reconnect) console.log("RECONNECT RECOMMENDED");*/
      var eventPatt = eventPattern;
      if (eventPattern != null) {
        eventPatt = eventPattern.endsWith("*")
          ? eventPattern.substring(0, eventPattern.length - 1)
          : eventPattern + " ";
      }
      if (eventPattern == null) {
        for (var k of Object.keys(responseTagCallbackMap)) {
          rmv(responseTagCallbackMap[k]);
        };
      } else if (queryObject == null) {
        for (var k of Object.keys(responseTagCallbackMap)) {
          if (k.indexOf(eventPattern) == 0)
            rmv(responseTagCallbackMap[k]);
        }
      } else {
        var responseTag = eventPatt + tagDelimiter + JSON.stringify(queryObject);
        rmv(responseTagCallbackMap[responseTag]);
      }
      function rmv(from) {
        if (from == null) return; //ignore requests to remove nonexistant listeners.
        var eventObj = from;
        var callbacks = eventObj.callbacks;
        var idxof = callbacks.indexOf(callback);
        if (idxof > -1) {
          callbacks.splice(idxof, 1);
        }
      }
      /*if (reconnect && othis.isConnected) {
        this.graceTimer.connectSoon();
      }*/
    };
  
    /**cleans out any responseTags which no longer have any listeners
     */
    this.clearEmptyResponseTags = () => {
      Object.keys(responseTagCallbackMap).forEach(k => {
        if (responseTagCallbackMap[k].callbacks == null ||
          responseTagCallbackMap[k].callbacks.length == 0) {
          delete responseTagCallbackMap[k];
        }
      });
    }
  
    /**
     * Call once after registering everything you want to register.
     *
     * Note that if using the php convenience function to instantiate the PseudoSocket,
     * this will already have been called for you once all of the elements on the page
     * have been loaded (and the ones marked for listening have registered themselves with this listener).
     *
     * It's okay to add new items after you've already connected,
     * but it's a bit slower than adding everything you want in advance, and only
     * connecting afterward. If you want to add multiple items in quick succession,
     * it's preferable to call disconnect() first,  then call connect() again once you
     * have registered your sequence of listeners.
     */
    this.doConnect = () => {
      var registrationArray = [];
      this.clearEmptyResponseTags();
      Object.keys(responseTagCallbackMap).forEach(o => {
        //var autoWorkspace = null;
        var qobj = responseTagCallbackMap[o].queryObj;
        /*autoWorkspace = currentWorkspace;
        if (qobj.params != null) {
          if (qobj.params.data != null) {
            if (qobj.params.data.workspace_id == null)
              qobj.params.data.workspace_id = currentWorkspace;
            else
              autoWorkspace = qobj.params.data.workspace_id;
          } else if (qobj.params.workspace_id != null) {
            autoWorkspace = qobj.params.workspace_id;
          } else if (qobj.workspace_id != null)
            autoWorkspace = qobj.workspace_id;
        }*/
  
        var obj = {
          responseTag: o,
          eventPattern: responseTagCallbackMap[o].eventPattern,
          queryObj: responseTagCallbackMap[o].queryObj,
          //workspace_id: autoWorkspace
        };
        registrationArray.push(obj);
      });
      if (registrationArray.length > 0) {
        workerService.port.postMessage({
          register: true,
          eventURL: eventsrc_url,
          listeners: registrationArray
        });
        this.graceTimer.firstConnect = false;
        workerService.port.onmessage = function (e) {
          if (e.data.connectionAck != undefined && e.data.connectionAck == true) {
            othis.isConnected = true;
          } else {
            var responseJSON = e.data;
            var listenerInfo = responseTagCallbackMap[responseJSON.responseTag];
            var listeners = listenerInfo.callbacks;
            listeners.forEach(l => {
              var jcopy = JSON.parse(JSON.stringify(e.data));
              l({
                errorStatus: jcopy.errorStatus,
                eventPattern: jcopy.eventPattern,
                eventBroadcast: jcopy.eventBroadcast,
                eventMessage: jcopy.eventMessage,
                queryObject: jcopy.queryObj,
                queryResult: jcopy.queryResult
              });
            });
          }
        };
      }
    };
  
    this.getResponseTagCallbackMap = () => {
      return responseTagCallbackMap;
    }
  
    this.connect = () => {
      this.graceTimer.connectSoon();
    };
  
    /**
     * Ideally, you should call this function if you have already called the connect()
     * function, but wish to register a large number of new listeners with the pSocket.
     */
    this.disconnect = () => {
      if (othis.isConnected) {
        othis.isConnected = false;
      }
    };
    var othis = this;
    /**
     * 50ms delay before attempting to reregister
     * with the server, so we don't have to care
     * about connecting and disconnecting
     * if a ton of elements change while we're still
     * connected
     */
    this.graceTimer = {
      firstConnect: true,
      connectSoon: function (event) {
        if (typeof this.timeoutID === "number") {
          this.reset(event);
        }
        var waitFor = this.firstConnect ? 500 : 300;
        this.timeoutID = window.setTimeout(() => {
          othis.doConnect();
        }, waitFor);
  
      },
      reset: function (event) {
        //console.log("graced");
        window.clearTimeout(this.timeoutID);
      }
    };
  }
  
  
  /**creates a serverListener for the given element if it doesn't 
   * already have one and returns it. 
   * If it does already have one, returns the one 
   * already attached to the element*/
  function getOrAddServerListenerFor(elem) {
    if (elem.serverListener != null) return elem.serverListener;
    else {
      var listener = new ServerListener(elem);
      return listener;
    }
  }
  
  
  /**
   * declares a new generic listener for serverEvents to be attached to a given DOMNode.
   * Provides convenience functions for organizing eventPatterns by key, and automatically
   * unregistering or reregestering the existing listeners when updating those eventPatterns
   */
  class ServerListener {
  
    constructor(node) {
      node.serverListener = this;
      this.node = node;
      this.listeners = {};
    }
  
    /**
     * @param {string} listenerName the existing name of a previously registered listener. If no listener under this name 
     * exists, a new one will be created. If one does existed but was inactivated 
     * 
     * @param {any} eventPattern the eventPattern to listen for. Can be either a single eventPattern given as a string, 
     * or multiple eventPattenrs given as an array of strings. If multiple eventPatterns are given, they will all trigger
     * the singular callback queryFunction provided, which will in turn trigger the single callback provided.
     * 
     * @param {JSONObj} queryObject the xReq formatted request for the server to 
     * return whenever the given event pattern is broadcast 
     * 
     * @param {function} callback a callback to be notified of a server event. The callback will 
     * be provided with two arguments. First, the actual serverEvent object, and second 
     * a reference to the node to which this listener is attached
     */
    setListener(listenerName, eventPattern, queryObject, callback) {
      var callbackObj = null;
      if (this.listeners[listenerName] == null) {
        callbackObj = new CallbackWrapper(callback, this);
        this.listeners[listenerName] = {
          eventPattern: null,
          queryObj: null,
          callback: callbackObj.exec,
          amActive: false,
          cbObj: callbackObj
        };
        var registrationRequired = true;
      } else {
        callbackObj = this.listeners[listenerName].cbObj;
        callbackObj.callback = callback;
      }
      var listenerObj = this.listeners[listenerName];
  
      if (listenerObj.eventPattern != eventPattern
        || JSON.stringify(listenerObj.queryObj) != JSON.stringify(queryObject)) {
        this.removeListener(listenerName);
        registrationRequired = true;
        listenerObj.eventPattern = eventPattern;
        listenerObj.queryObj = queryObject;
      }
  
      if (registrationRequired) {
        if (this.node.isConnected) {
          this.addEvs(listenerObj);
        }
      }
    }
  
    addEvs(listenerObj) {
      if(Array.isArray(listenerObj.eventPattern)) {
        for(var i=0; i<listenerObj.eventPattern.length; i++)
          pseudoSocket.addServerEventListener(listenerObj.eventPattern[i], listenerObj.queryObj, listenerObj.callback);
      } else {
          pseudoSocket.addServerEventListener(listenerObj.eventPattern, listenerObj.queryObj, listenerObj.callback); 
      }
      listenerObj.amActive = true;
    }
  
    /**removes the listener with the given name if it exists */
    removeListener(listenerName) {
      var listenerObj = this.listeners[listenerName];
      if (listenerObj != null && listenerObj.amActive) {
        if(Array.isArray(listenerObj.eventPattern)) {
          for(var i=0; i<listenerObj.eventPattern.length; i++)
            pseudoSocket.removeClientSideEventListener(listenerObj.callback, listenerObj.eventPattern[i], listenerObj.queryObj);
        } 
        else {
          pseudoSocket.removeClientSideEventListener(listenerObj.callback, listenerObj.eventPattern, listenerObj.queryObj);
        }
        listenerObj.amActive = false;
      }
    }
  
    nodeDisconnected() {
      for (var k of Object.keys(this.listeners)) {
        this.removeListener(k);
      }
    }
  
    nodeConnected() {
      for (var k of Object.keys(this.listeners)) {
        var listenerObj = this.listeners[k];
        if (listenerObj.amActive == false) {
          this.addEvs(listenerObj);
          //pseudoSocket.addServerEventListener(listenerObj.eventPattern, listenerObj.queryObj, listenerObj.callback);       
        }
      }
    }
  }
  
  
  class CallbackWrapper {
    constructor(callback, forListener) {
      this.callback = callback;
      this.forListener = forListener;
    }
  
    exec = serverEvent => {
      this.callback(serverEvent, this.forListener.node);
    }
  }
  
  var nodeModObserver = new MutationObserver(function (mutations) {
    // check for removed target
    mutations.forEach(function (mutation) {
      mutation.removedNodes.forEach((node) => {
        if (node.serverListener != null) {
          node.serverListener.nodeDisconnected();
        }
      });
      mutation.addedNodes.forEach((node) => {
        if (node.serverListener != null) {
          node.serverListener.nodeConnected()
        }
      });
    });
  });
  
  var config = {
    subtree: true,
    childList: true
  };
  document.addEventListener('DOMContentLoaded', function () {
    nodeModObserver.observe(document.querySelector("body"), config);
  });
