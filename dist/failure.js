!function(e){if("object"==typeof exports&&"undefined"!=typeof module)module.exports=e();else if("function"==typeof define&&define.amd)define([],e);else{var f;"undefined"!=typeof window?f=window:"undefined"!=typeof global?f=global:"undefined"!=typeof self&&(f=self),f.Failure=e()}}(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
// Emulates V8's CallSite object from a stacktrace.js frame object

function CallSite (frame) {
  if (!(this instanceof CallSite)) {
    return new CallSite(frame);
  }
  this.frame = frame;
};

CallSite.prototype = Object.create({
  getLineNumber: function () {
    return this.frame.lineNumber;
  },
  getColumnNumber: function () {
    return this.frame.columnNumber;
  },
  getFileName: function () {
    return this.frame.fileName;
  },
  getFunction: function () {
    return this.frame.function;
  },
  getThis: function () {
    return null;
  },
  getTypeName: function () {
    return null;
  },
  getMethodName: function () {
    if (this.frame.functionName) {
      return this.frame.functionName.split('.').pop();
    }
    return null;
  },
  getFunctionName: function () {
    return this.frame.functionName;
  },
  getEvalOrigin: function () {
    return null;
  },
  isToplevel: function () {
    return false; // TODO
  },
  isEval: function () {
    return false; // TODO
  },
  isNative: function () {
    return false; // TODO
  },
  isConstructor: function () {
    return /^new(\s|$)/.test(this.frame.functionName);
  },
  toString: function () {
    var name = this.getFunctionName() || '<anonymous>';
    var loc = this.getFileName() + ':' + this.getLineNumber() + ':' + this.getColumnNumber()
    return name + ' (' + loc + ')';
  }
});


module.exports = CallSite;

},{}],2:[function(require,module,exports){
(function (process,global){
var ErrorStackParser = require('error-stack-parser');
var CallSite = require('./call-site');

// Keep a reference to the builtin error constructor
var NativeError = Error;


function Failure (message, sff) {
  if (!(this instanceof Failure)) {
    return new Failure(message, sff || Failure);
  }

  this.sff = sff || this.constructor;

  this.message = message;

  // Generate a getter for the frames, this ensures that we do as little work
  // as possible when instantiating the error, deferring the expensive stack
  // mangling operations until the .stack property is actually requested.
  this._getFrames = makeFramesGetter(this.sff);

  // On ES5 engines we use one-time getters to actually defer the expensive
  // operations (defined in the prototype for performance reasons) while legacy
  // engines will simply do all the work up front.
  if (typeof Object.defineProperty !== 'function') {
    this.frames = unwind(this._getFrames());
    this._getFrames(true);
    this._getFrames = null;
    this.stack = this.generateStackTrace();
  }

  return this;
}

// Set FRAME_EMPTY to null to disable any sort of separator
Failure.FRAME_EMPTY = '  ----------------------------------------';
Failure.FRAME_PREFIX = '  at ';

// By default we enable tracking for async stack traces
Failure.TRACK = true;


// Helper to obtain the current stack trace
var getErrorWithStack = function () {
  return new NativeError;
};
// Some engines do not generate the .stack property until it's thrown
if (!getErrorWithStack().stack) {
  getErrorWithStack = function () {
    try { throw new NativeError } catch (e) { return e };
  };
}

// Trim frames under the provided stack first function
function trim(frames, sff) {
  var fn, name = sff.name;
  if (!frames) {
    console.log('[Failure] error capturing frames');
    return [];
  }
  for (var i=0; i < frames.length; i++) {
    fn = frames[i].getFunction();
    if (fn && fn === sff || name && name === frames[i].getFunctionName()) {
      return frames.slice(i + 1);
    }
  }
  return frames;
}

function unwind (frames) {
  var result = [];

  for (var i=0, fn; i < frames.length; i++) {
    fn = frames[i].getFunction();

    if (!fn || !fn['failure:ignore']) {
      result.push(frames[i]);
    }

    if (fn && fn['failure:frames']) {
      if (Failure.FRAME_EMPTY) {
        result.push(null);
      }

      // Call the getter and keep a reference to the result in case we have to
      // unwind the same function another time.
      // TODO: Make sure keeping a reference to the frames doesn't create leaks
      if (typeof fn['failure:frames'] === 'function') {
        var getter = fn['failure:frames'];
        fn['failure:frames'] = null;
        fn['failure:frames'] = getter();
      }

      result.push.apply(result, unwind(fn['failure:frames']));
      break;
    }
  }

  return result;
}

// Receiver for the frames in a .stack property from captureStackTrace
var V8FRAMES = {};

// V8 code path for generating a frames getter
function makeFramesGetterV8 (sff) {
  NativeError.captureStackTrace(V8FRAMES, sff || makeFramesGetterV8);
  sff = null;
  var frames = V8FRAMES.stack;
  V8FRAMES.stack = null;  // IMPORTANT: This is needed to avoid leaks!!!
  return function (cleanup) {
    var result = frames;
    // Clean up closure variables to help GC
    frames = null;
    return result;
  };
}

// non-V8 code path for generating a frames getter
function makeFramesGetterCompat (sff) {
  // Obtain a stack trace at the current point
  var error = getErrorWithStack();

  // Walk the caller chain to annotate the stack with function references
  // Given the limitations imposed by ES5 "strict mode" it's not possible
  // to obtain references to functions beyond one that is defined in strict
  // mode. Also note that any kind of recursion will make the walker unable
  // to go past it.
  var caller = arguments.callee;
  var functions = [getErrorWithStack];
  for (var i=0; caller && i < 10; i++) {
    functions.push(caller);
    if (caller.caller === caller) break;
    caller = caller.caller;
  }
  caller = null;

  return function (cleanup) {
    var frames = null;

    if (!cleanup) {
      // Parse the stack trace
      frames = ErrorStackParser.parse(error);
      // Attach function references to the frames (skipping the maker frames)
      // and creating CallSite objects for each one.
      for (var i=2; i < frames.length; i++) {
        frames[i].function = functions[i];
        frames[i] = new CallSite(frames[i]);
      }

      frames = trim(frames.slice(2), sff);
    }

    // Clean up closure variables to help GC
    sff = null;
    error = null;
    functions = null;

    return frames;
  };
}

// Generates a getter for the call site frames
// TODO: If we observe leaks with complex use cases (due to closure scopes)
//       we can generate here our compat CallSite objects storing the function's
//       source code instead of an actual reference to them, that should help
//       the GC since we'll be just keeping literals around.
var makeFramesGetter = typeof NativeError.captureStackTrace === 'function'
                     ? makeFramesGetterV8
                     : makeFramesGetterCompat;


// Override V8 stack trace builder to inject our logic
var oldPrepareStackTrace = Error.prepareStackTrace;
Error.prepareStackTrace = function (error, frames) {
  // When called from makeFramesGetter we just want to obtain the frames
  if (error === V8FRAMES) {
    return frames;
  }

  // Forward to any previously defined behaviour
  if (oldPrepareStackTrace) {
    return oldPrepareStackTrace.call(Error, error, frames);
  }

  // Emulate default behaviour (with long-traces)
  return Failure.prototype.prepareStackTrace.call(error, unwind(frames));
};

// Attach a new exclusion predicate for frames
function exclude (ctor, predicate) {
  var fn = predicate;

  if (typeof predicate === 'string') {
    fn = function (frame) {
      return -1 !== frame.getFileName().indexOf(predicate);
    };
  } else if (typeof predicate.test === 'function') {
    fn = function (frame) {
      return predicate.test(frame.getFileName());
    };
  }

  ctor.excludes.push(fn);
}

// Expose the filter in the root Failure type
Failure.excludes = [];
Failure.exclude = function Failure_exclude (predicate) {
  exclude(Failure, predicate);
};

// Attach a frames getter to the function so we can re-construct async stacks.
//
// Note that this just augments the function with the new property, it doesn't
// create a wrapper every time it's called, so using it multiple times on the
// same function will indeed overwrite the previous tracking information. This
// is intended since it's faster and more importantly doesn't break some APIs
// using callback references to unregister them for instance.
// When you want to use the same function with different tracking information
// just use Failure.wrap().
//
// The tracking can be globally disabled by setting Failure.TRACK to false
Failure.track = function Failure_track (fn, sff) {
  if (typeof fn !== 'function') {
    return fn;
  }

  // Clean up previous frames to help the GC
  if (typeof fn['failure:frames'] === 'function') {
    fn['failure:frames'](true);
  }

  if (Failure.TRACK) {
    fn['failure:frames'] = null;
    fn['failure:frames'] = makeFramesGetter(sff || Failure_track);
  }

  return fn;
};

// Wraps the function before annotating it with tracking information, this
// allows to track multiple schedullings of a single function.
Failure.wrap = function Failure_wrap (fn) {
  var wrapper = Failure.ignore(function () {
    return fn.apply(this, arguments);
  });

  return Failure.track(wrapper, Failure_wrap);
};

// Mark a function to be ignored when generating stack traces
Failure.ignore = function Failure_ignore (fn) {
  fn['failure:ignore'] = true;
  return fn;
};

Failure.setTimeout = function Failure_setTimeout () {
  arguments[0] = Failure.track(arguments[0], Failure_setTimeout);
  return setTimeout.apply(null, arguments);
};

Failure.nextTick = function Failure_nextTick () {
  arguments[0] = Failure.track(arguments[0], Failure_nextTick);
  return process.nextTick.apply(process, arguments);
};

Failure.patch = function Failure_patch(obj, name, idx) {
  if (obj && typeof obj[name] !== 'function') {
    throw new Error('Object does not have a "' + name + '" method');
  }

  var original = obj[name];

  // When the exact argument index is provided use an optimized code path
  if (typeof idx === 'number') {

    obj[name] = function () {
      arguments[idx] = Failure.track(arguments[idx], obj[name]);
      return original.apply(this, arguments);
    };

  // Otherwise detect the functions to track at invokation time
  } else {

    obj[name] = function () {
      for (var i = 0; i < arguments.length; i++) {
        if (typeof arguments[i] === 'function') {
          arguments[i] = Failure.track(arguments[i], obj[name]);
        }
      }
      return original.apply(this, arguments);
    };

  }

  // Augment the wrapper with any properties from the original
  for (var k in original) if (original.hasOwnProperty(k)) {
    obj[name][k] = original[k];
  }

  return obj[name];
};

// Helper to create new Failure types
Failure.create = function (name, props) {
  if (typeof name !== 'string') {
    throw new Failure('Expected a name as first argument');
  }

  function ctor (message, sff) {
    if (!(this instanceof Failure)) {
      return new ctor(message, sff);
    }
    Failure.apply(this, arguments);
  }

  // Augment constructor
  ctor.excludes = [];
  ctor.exclude = function (predicate) {
    exclude(ctor, predicate);
  };

  ctor.prototype = Object.create(Failure.prototype);
  ctor.prototype.constructor = ctor;
  ctor.prototype.name = name;
  if (typeof props === 'function') {
    ctor.prototype.prepareStackTrace = props;
  } else if (props) {
    Object.keys(props).forEach(function (prop) {
      ctor.prototype[prop] = prop;
    });
  }
  return ctor;
};

var builtinErrorTypes = [
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError',
  'EvalError', 'URIError', 'InternalError'
];
var builtinErrors = {};

Failure.install = function () {
  var root = typeof window === 'object' ? window : global;

  builtinErrorTypes.forEach(function (type) {
    if (root[type] && !builtinErrors[type]) {
      builtinErrors[type] = root[type];
      root[type] = Failure.create(type);
    }
  });

  // Allow usage: var Failure = require('failure').install()
  return Failure;
};

Failure.uninstall = function () {
  builtinErrorTypes.forEach(function (type) {
    root[type] = builtinErrors[type] || root[type];
  });
};


var proto = Failure.prototype = Object.create(Error.prototype);
proto.constructor = Failure;

proto.name = 'Failure';
proto.message = '';

if (typeof Object.defineProperty === 'function') {
  Object.defineProperty(proto, 'frames', {
    get: function () {
      // Use trimming just in case the sff was defined after constructing
      var frames = unwind(trim(this._getFrames(), this.sff));

      // Cache next accesses to the property
      Object.defineProperty(this, 'frames', {
        value: frames,
        writable: true
      });

      // Clean up the getter closure
      this._getFrames = null;

      return frames;
    }
  });

  Object.defineProperty(proto, 'stack', {
    get: function () {
      return this.generateStackTrace();
    }
  });
}

proto.generateStackTrace = function () {
  var excludes = this.constructor.excludes;
  var include, frames = [];

  // Specific prototypes inherit the excludes from Failure
  if (excludes !== Failure.excludes) {
    excludes.push.apply(excludes, Failure.excludes);
  }

  // Apply filtering
  for (var i=0; i < this.frames.length; i++) {
    include = true;
    if (this.frames[i]) {
      for (var j=0; include && j < excludes.length; j++) {
        include &= !excludes[j].call(this, this.frames[i]);
      }
    }
    if (include) {
      frames.push(this.frames[i]);
    }
  }

  // Honor any previously defined stacktrace formatter by
  // allowing it finally format the frames. This is needed
  // when using node-source-map-support for instance.
  // TODO: Can we map the "null" frames to a CallFrame shim?
  if (oldPrepareStackTrace) {
    frames = frames.filter(function (x) { return !!x; });
    return oldPrepareStackTrace.call(Error, this, frames);
  }

  return this.prepareStackTrace(frames);
};

proto.prepareStackTrace = function (frames) {
  var lines = [this];
  for (var i=0; i < frames.length; i++) {
    lines.push(
      frames[i] ? Failure.FRAME_PREFIX + frames[i] : Failure.FRAME_EMPTY
    );
  }
  return lines.join('\n');
};


module.exports = Failure;

}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{"./call-site":1,"_process":4,"error-stack-parser":5}],3:[function(require,module,exports){
var Failure = require('./lib/failure');

module.exports = Failure;

},{"./lib/failure":2}],4:[function(require,module,exports){
// shim for using process in browser

var process = module.exports = {};

process.nextTick = (function () {
    var canSetImmediate = typeof window !== 'undefined'
    && window.setImmediate;
    var canMutationObserver = typeof window !== 'undefined'
    && window.MutationObserver;
    var canPost = typeof window !== 'undefined'
    && window.postMessage && window.addEventListener
    ;

    if (canSetImmediate) {
        return function (f) { return window.setImmediate(f) };
    }

    var queue = [];

    if (canMutationObserver) {
        var hiddenDiv = document.createElement("div");
        var observer = new MutationObserver(function () {
            var queueList = queue.slice();
            queue.length = 0;
            queueList.forEach(function (fn) {
                fn();
            });
        });

        observer.observe(hiddenDiv, { attributes: true });

        return function nextTick(fn) {
            if (!queue.length) {
                hiddenDiv.setAttribute('yes', 'no');
            }
            queue.push(fn);
        };
    }

    if (canPost) {
        window.addEventListener('message', function (ev) {
            var source = ev.source;
            if ((source === window || source === null) && ev.data === 'process-tick') {
                ev.stopPropagation();
                if (queue.length > 0) {
                    var fn = queue.shift();
                    fn();
                }
            }
        }, true);

        return function nextTick(fn) {
            queue.push(fn);
            window.postMessage('process-tick', '*');
        };
    }

    return function nextTick(fn) {
        setTimeout(fn, 0);
    };
})();

process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

// TODO(shtylman)
process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};

},{}],5:[function(require,module,exports){
(function (root, factory) {
    'use strict';
    // Universal Module Definition (UMD) to support AMD, CommonJS/Node.js, Rhino, and browsers.
    if (typeof define === 'function' && define.amd) {
        define('error-stack-parser', ['stackframe'], factory);
    } else if (typeof exports === 'object') {
        module.exports = factory(require('stackframe'));
    } else {
        root.ErrorStackParser = factory(root.StackFrame);
    }
}(this, function ErrorStackParser(StackFrame) {
    'use strict';

    // ES5 Polyfills
    // See https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map
    if (!Array.prototype.map) {
        Array.prototype.map = function(callback, thisArg) {
            var O = Object(this);
            var len = O.length >>> 0;
            var T;
            if (arguments.length > 1) {
                T = thisArg;
            }

            var A = new Array(len);
            var k = 0;

            while (k < len) {
                var kValue, mappedValue;
                if (k in O) {
                    kValue = O[k];
                    mappedValue = callback.call(T, kValue, k, O);
                    A[k] = mappedValue;
                }
                k++;
            }

            return A;
        };
    }

    // See https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/filter
    if (!Array.prototype.filter) {
        Array.prototype.filter = function(callback/*, thisArg*/) {
            var t = Object(this);
            var len = t.length >>> 0;

            var res = [];
            var thisArg = arguments.length >= 2 ? arguments[1] : void 0;
            for (var i = 0; i < len; i++) {
                if (i in t) {
                    var val = t[i];
                    if (callback.call(thisArg, val, i, t)) {
                        res.push(val);
                    }
                }
            }

            return res;
        };
    }

    var FIREFOX_SAFARI_STACK_REGEXP = /\S+\:\d+/;
    var CHROME_IE_STACK_REGEXP = /\s+at /;

    return {
        /**
         * Given an Error object, extract the most information from it.
         * @param error {Error}
         * @return Array[StackFrame]
         */
        parse: function ErrorStackParser$$parse(error) {
            if (typeof error.stacktrace !== 'undefined' || typeof error['opera#sourceloc'] !== 'undefined') {
                return this.parseOpera(error);
            } else if (error.stack && error.stack.match(CHROME_IE_STACK_REGEXP)) {
                return this.parseV8OrIE(error);
            } else if (error.stack && error.stack.match(FIREFOX_SAFARI_STACK_REGEXP)) {
                return this.parseFFOrSafari(error);
            } else {
                throw new Error('Cannot parse given Error object');
            }
        },

        /**
         * Separate line and column numbers from a URL-like string.
         * @param urlLike String
         * @return Array[String]
         */
        extractLocation: function ErrorStackParser$$extractLocation(urlLike) {
            var locationParts = urlLike.split(':');
            var lastNumber = locationParts.pop();
            var possibleNumber = locationParts[locationParts.length - 1];
            if (!isNaN(parseFloat(possibleNumber)) && isFinite(possibleNumber)) {
                var lineNumber = locationParts.pop();
                return [locationParts.join(':'), lineNumber, lastNumber];
            } else {
                return [locationParts.join(':'), lastNumber, undefined];
            }
        },

        parseV8OrIE: function ErrorStackParser$$parseV8OrIE(error) {
            return error.stack.split('\n').slice(1).map(function (line) {
                var tokens = line.replace(/^\s+/, '').split(/\s+/).slice(1);
                var locationParts = this.extractLocation(tokens.pop().replace(/[\(\)\s]/g, ''));
                var functionName = (!tokens[0] || tokens[0] === 'Anonymous') ? undefined : tokens[0];
                return new StackFrame(functionName, undefined, locationParts[0], locationParts[1], locationParts[2]);
            }, this);
        },

        parseFFOrSafari: function ErrorStackParser$$parseFFOrSafari(error) {
            return error.stack.split('\n').filter(function (line) {
                return !!line.match(FIREFOX_SAFARI_STACK_REGEXP);
            }, this).map(function (line) {
                var tokens = line.split('@');
                var locationParts = this.extractLocation(tokens.pop());
                var functionName = tokens.shift() || undefined;
                return new StackFrame(functionName, undefined, locationParts[0], locationParts[1], locationParts[2]);
            }, this);
        },

        parseOpera: function ErrorStackParser$$parseOpera(e) {
            if (!e.stacktrace || (e.message.indexOf('\n') > -1 &&
                e.message.split('\n').length > e.stacktrace.split('\n').length)) {
                return this.parseOpera9(e);
            } else if (!e.stack) {
                return this.parseOpera10(e);
            } else {
                return this.parseOpera11(e);
            }
        },

        parseOpera9: function ErrorStackParser$$parseOpera9(e) {
            var lineRE = /Line (\d+).*script (?:in )?(\S+)/i;
            var lines = e.message.split('\n');
            var result = [];

            for (var i = 2, len = lines.length; i < len; i += 2) {
                var match = lineRE.exec(lines[i]);
                if (match) {
                    result.push(new StackFrame(undefined, undefined, match[2], match[1]));
                }
            }

            return result;
        },

        parseOpera10: function ErrorStackParser$$parseOpera10(e) {
            var lineRE = /Line (\d+).*script (?:in )?(\S+)(?:: In function (\S+))?$/i;
            var lines = e.stacktrace.split('\n');
            var result = [];

            for (var i = 0, len = lines.length; i < len; i += 2) {
                var match = lineRE.exec(lines[i]);
                if (match) {
                    result.push(new StackFrame(match[3] || undefined, undefined, match[2], match[1]));
                }
            }

            return result;
        },

        // Opera 10.65+ Error.stack very similar to FF/Safari
        parseOpera11: function ErrorStackParser$$parseOpera11(error) {
            return error.stack.split('\n').filter(function (line) {
                return !!line.match(FIREFOX_SAFARI_STACK_REGEXP) &&
                    !line.match(/^Error created at/);
            }, this).map(function (line) {
                var tokens = line.split('@');
                var locationParts = this.extractLocation(tokens.pop());
                var functionCall = (tokens.shift() || '');
                var functionName = functionCall
                        .replace(/<anonymous function(: (\w+))?>/, '$2')
                        .replace(/\([^\)]*\)/g, '') || undefined;
                var argsRaw;
                if (functionCall.match(/\(([^\)]*)\)/)) {
                    argsRaw = functionCall.replace(/^[^\(]+\(([^\)]*)\)$/, '$1');
                }
                var args = (argsRaw === undefined || argsRaw === '[arguments not available]') ? undefined : argsRaw.split(',');
                return new StackFrame(functionName, args, locationParts[0], locationParts[1], locationParts[2]);
            }, this);
        }
    };
}));


},{"stackframe":6}],6:[function(require,module,exports){
(function (root, factory) {
    'use strict';
    // Universal Module Definition (UMD) to support AMD, CommonJS/Node.js, Rhino, and browsers.
    if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else if (typeof exports === 'object') {
        module.exports = factory();
    } else {
        root.StackFrame = factory();
    }
}(this, function () {
    'use strict';
    function _isNumber(n) {
        return !isNaN(parseFloat(n)) && isFinite(n);
    }

    function StackFrame(functionName, args, fileName, lineNumber, columnNumber) {
        if (functionName !== undefined) {
            this.setFunctionName(functionName);
        }
        if (args !== undefined) {
            this.setArgs(args);
        }
        if (fileName !== undefined) {
            this.setFileName(fileName);
        }
        if (lineNumber !== undefined) {
            this.setLineNumber(lineNumber);
        }
        if (columnNumber !== undefined) {
            this.setColumnNumber(columnNumber);
        }
    }

    StackFrame.prototype = {
        getFunctionName: function () {
            return this.functionName;
        },
        setFunctionName: function (v) {
            this.functionName = String(v);
        },

        getArgs: function () {
            return this.args;
        },
        setArgs: function (v) {
            if (Object.prototype.toString.call(v) !== '[object Array]') {
                throw new TypeError('Args must be an Array');
            }
            this.args = v;
        },

        // NOTE: Property name may be misleading as it includes the path,
        // but it somewhat mirrors V8's JavaScriptStackTraceApi
        // https://code.google.com/p/v8/wiki/JavaScriptStackTraceApi
        getFileName: function () {
            return this.fileName;
        },
        setFileName: function (v) {
            this.fileName = String(v);
        },

        getLineNumber: function () {
            return this.lineNumber;
        },
        setLineNumber: function (v) {
            if (!_isNumber(v)) {
                throw new TypeError('Line Number must be a Number');
            }
            this.lineNumber = Number(v);
        },

        getColumnNumber: function () {
            return this.columnNumber;
        },
        setColumnNumber: function (v) {
            if (!_isNumber(v)) {
                throw new TypeError('Column Number must be a Number');
            }
            this.columnNumber = Number(v);
        },

        toString: function() {
            var functionName = this.getFunctionName() || '{anonymous}';
            var args = '(' + (this.getArgs() || []).join(',') + ')';
            var fileName = this.getFileName() ? ('@' + this.getFileName()) : '';
            var lineNumber = _isNumber(this.getLineNumber()) ? (':' + this.getLineNumber()) : '';
            var columnNumber = _isNumber(this.getColumnNumber()) ? (':' + this.getColumnNumber()) : '';
            return functionName + args + fileName + lineNumber + columnNumber;
        }
    };

    return StackFrame;
}));

},{}]},{},[3])(3)
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJsaWIvY2FsbC1zaXRlLmpzIiwibGliL2ZhaWx1cmUuanMiLCJtYWluLmpzIiwibm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL3Byb2Nlc3MvYnJvd3Nlci5qcyIsIm5vZGVfbW9kdWxlcy9lcnJvci1zdGFjay1wYXJzZXIvZXJyb3Itc3RhY2stcGFyc2VyLmpzIiwibm9kZV9tb2R1bGVzL2Vycm9yLXN0YWNrLXBhcnNlci9ub2RlX21vZHVsZXMvc3RhY2tmcmFtZS9zdGFja2ZyYW1lLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO0FDQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FDN0RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDemJBO0FBQ0E7QUFDQTtBQUNBOztBQ0hBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0RkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN4TEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSIsImZpbGUiOiJnZW5lcmF0ZWQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uIGUodCxuLHIpe2Z1bmN0aW9uIHMobyx1KXtpZighbltvXSl7aWYoIXRbb10pe3ZhciBhPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7aWYoIXUmJmEpcmV0dXJuIGEobywhMCk7aWYoaSlyZXR1cm4gaShvLCEwKTt2YXIgZj1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK28rXCInXCIpO3Rocm93IGYuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixmfXZhciBsPW5bb109e2V4cG9ydHM6e319O3Rbb11bMF0uY2FsbChsLmV4cG9ydHMsZnVuY3Rpb24oZSl7dmFyIG49dFtvXVsxXVtlXTtyZXR1cm4gcyhuP246ZSl9LGwsbC5leHBvcnRzLGUsdCxuLHIpfXJldHVybiBuW29dLmV4cG9ydHN9dmFyIGk9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtmb3IodmFyIG89MDtvPHIubGVuZ3RoO28rKylzKHJbb10pO3JldHVybiBzfSkiLCIvLyBFbXVsYXRlcyBWOCdzIENhbGxTaXRlIG9iamVjdCBmcm9tIGEgc3RhY2t0cmFjZS5qcyBmcmFtZSBvYmplY3RcblxuZnVuY3Rpb24gQ2FsbFNpdGUgKGZyYW1lKSB7XG4gIGlmICghKHRoaXMgaW5zdGFuY2VvZiBDYWxsU2l0ZSkpIHtcbiAgICByZXR1cm4gbmV3IENhbGxTaXRlKGZyYW1lKTtcbiAgfVxuICB0aGlzLmZyYW1lID0gZnJhbWU7XG59O1xuXG5DYWxsU2l0ZS5wcm90b3R5cGUgPSBPYmplY3QuY3JlYXRlKHtcbiAgZ2V0TGluZU51bWJlcjogZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiB0aGlzLmZyYW1lLmxpbmVOdW1iZXI7XG4gIH0sXG4gIGdldENvbHVtbk51bWJlcjogZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiB0aGlzLmZyYW1lLmNvbHVtbk51bWJlcjtcbiAgfSxcbiAgZ2V0RmlsZU5hbWU6IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gdGhpcy5mcmFtZS5maWxlTmFtZTtcbiAgfSxcbiAgZ2V0RnVuY3Rpb246IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gdGhpcy5mcmFtZS5mdW5jdGlvbjtcbiAgfSxcbiAgZ2V0VGhpczogZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiBudWxsO1xuICB9LFxuICBnZXRUeXBlTmFtZTogZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiBudWxsO1xuICB9LFxuICBnZXRNZXRob2ROYW1lOiBmdW5jdGlvbiAoKSB7XG4gICAgaWYgKHRoaXMuZnJhbWUuZnVuY3Rpb25OYW1lKSB7XG4gICAgICByZXR1cm4gdGhpcy5mcmFtZS5mdW5jdGlvbk5hbWUuc3BsaXQoJy4nKS5wb3AoKTtcbiAgICB9XG4gICAgcmV0dXJuIG51bGw7XG4gIH0sXG4gIGdldEZ1bmN0aW9uTmFtZTogZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiB0aGlzLmZyYW1lLmZ1bmN0aW9uTmFtZTtcbiAgfSxcbiAgZ2V0RXZhbE9yaWdpbjogZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiBudWxsO1xuICB9LFxuICBpc1RvcGxldmVsOiBmdW5jdGlvbiAoKSB7XG4gICAgcmV0dXJuIGZhbHNlOyAvLyBUT0RPXG4gIH0sXG4gIGlzRXZhbDogZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiBmYWxzZTsgLy8gVE9ET1xuICB9LFxuICBpc05hdGl2ZTogZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiBmYWxzZTsgLy8gVE9ET1xuICB9LFxuICBpc0NvbnN0cnVjdG9yOiBmdW5jdGlvbiAoKSB7XG4gICAgcmV0dXJuIC9ebmV3KFxcc3wkKS8udGVzdCh0aGlzLmZyYW1lLmZ1bmN0aW9uTmFtZSk7XG4gIH0sXG4gIHRvU3RyaW5nOiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIG5hbWUgPSB0aGlzLmdldEZ1bmN0aW9uTmFtZSgpIHx8ICc8YW5vbnltb3VzPic7XG4gICAgdmFyIGxvYyA9IHRoaXMuZ2V0RmlsZU5hbWUoKSArICc6JyArIHRoaXMuZ2V0TGluZU51bWJlcigpICsgJzonICsgdGhpcy5nZXRDb2x1bW5OdW1iZXIoKVxuICAgIHJldHVybiBuYW1lICsgJyAoJyArIGxvYyArICcpJztcbiAgfVxufSk7XG5cblxubW9kdWxlLmV4cG9ydHMgPSBDYWxsU2l0ZTtcbiIsInZhciBFcnJvclN0YWNrUGFyc2VyID0gcmVxdWlyZSgnZXJyb3Itc3RhY2stcGFyc2VyJyk7XG52YXIgQ2FsbFNpdGUgPSByZXF1aXJlKCcuL2NhbGwtc2l0ZScpO1xuXG4vLyBLZWVwIGEgcmVmZXJlbmNlIHRvIHRoZSBidWlsdGluIGVycm9yIGNvbnN0cnVjdG9yXG52YXIgTmF0aXZlRXJyb3IgPSBFcnJvcjtcblxuXG5mdW5jdGlvbiBGYWlsdXJlIChtZXNzYWdlLCBzZmYpIHtcbiAgaWYgKCEodGhpcyBpbnN0YW5jZW9mIEZhaWx1cmUpKSB7XG4gICAgcmV0dXJuIG5ldyBGYWlsdXJlKG1lc3NhZ2UsIHNmZiB8fCBGYWlsdXJlKTtcbiAgfVxuXG4gIHRoaXMuc2ZmID0gc2ZmIHx8IHRoaXMuY29uc3RydWN0b3I7XG5cbiAgdGhpcy5tZXNzYWdlID0gbWVzc2FnZTtcblxuICAvLyBHZW5lcmF0ZSBhIGdldHRlciBmb3IgdGhlIGZyYW1lcywgdGhpcyBlbnN1cmVzIHRoYXQgd2UgZG8gYXMgbGl0dGxlIHdvcmtcbiAgLy8gYXMgcG9zc2libGUgd2hlbiBpbnN0YW50aWF0aW5nIHRoZSBlcnJvciwgZGVmZXJyaW5nIHRoZSBleHBlbnNpdmUgc3RhY2tcbiAgLy8gbWFuZ2xpbmcgb3BlcmF0aW9ucyB1bnRpbCB0aGUgLnN0YWNrIHByb3BlcnR5IGlzIGFjdHVhbGx5IHJlcXVlc3RlZC5cbiAgdGhpcy5fZ2V0RnJhbWVzID0gbWFrZUZyYW1lc0dldHRlcih0aGlzLnNmZik7XG5cbiAgLy8gT24gRVM1IGVuZ2luZXMgd2UgdXNlIG9uZS10aW1lIGdldHRlcnMgdG8gYWN0dWFsbHkgZGVmZXIgdGhlIGV4cGVuc2l2ZVxuICAvLyBvcGVyYXRpb25zIChkZWZpbmVkIGluIHRoZSBwcm90b3R5cGUgZm9yIHBlcmZvcm1hbmNlIHJlYXNvbnMpIHdoaWxlIGxlZ2FjeVxuICAvLyBlbmdpbmVzIHdpbGwgc2ltcGx5IGRvIGFsbCB0aGUgd29yayB1cCBmcm9udC5cbiAgaWYgKHR5cGVvZiBPYmplY3QuZGVmaW5lUHJvcGVydHkgIT09ICdmdW5jdGlvbicpIHtcbiAgICB0aGlzLmZyYW1lcyA9IHVud2luZCh0aGlzLl9nZXRGcmFtZXMoKSk7XG4gICAgdGhpcy5fZ2V0RnJhbWVzKHRydWUpO1xuICAgIHRoaXMuX2dldEZyYW1lcyA9IG51bGw7XG4gICAgdGhpcy5zdGFjayA9IHRoaXMuZ2VuZXJhdGVTdGFja1RyYWNlKCk7XG4gIH1cblxuICByZXR1cm4gdGhpcztcbn1cblxuLy8gU2V0IEZSQU1FX0VNUFRZIHRvIG51bGwgdG8gZGlzYWJsZSBhbnkgc29ydCBvZiBzZXBhcmF0b3JcbkZhaWx1cmUuRlJBTUVfRU1QVFkgPSAnICAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tJztcbkZhaWx1cmUuRlJBTUVfUFJFRklYID0gJyAgYXQgJztcblxuLy8gQnkgZGVmYXVsdCB3ZSBlbmFibGUgdHJhY2tpbmcgZm9yIGFzeW5jIHN0YWNrIHRyYWNlc1xuRmFpbHVyZS5UUkFDSyA9IHRydWU7XG5cblxuLy8gSGVscGVyIHRvIG9idGFpbiB0aGUgY3VycmVudCBzdGFjayB0cmFjZVxudmFyIGdldEVycm9yV2l0aFN0YWNrID0gZnVuY3Rpb24gKCkge1xuICByZXR1cm4gbmV3IE5hdGl2ZUVycm9yO1xufTtcbi8vIFNvbWUgZW5naW5lcyBkbyBub3QgZ2VuZXJhdGUgdGhlIC5zdGFjayBwcm9wZXJ0eSB1bnRpbCBpdCdzIHRocm93blxuaWYgKCFnZXRFcnJvcldpdGhTdGFjaygpLnN0YWNrKSB7XG4gIGdldEVycm9yV2l0aFN0YWNrID0gZnVuY3Rpb24gKCkge1xuICAgIHRyeSB7IHRocm93IG5ldyBOYXRpdmVFcnJvciB9IGNhdGNoIChlKSB7IHJldHVybiBlIH07XG4gIH07XG59XG5cbi8vIFRyaW0gZnJhbWVzIHVuZGVyIHRoZSBwcm92aWRlZCBzdGFjayBmaXJzdCBmdW5jdGlvblxuZnVuY3Rpb24gdHJpbShmcmFtZXMsIHNmZikge1xuICB2YXIgZm4sIG5hbWUgPSBzZmYubmFtZTtcbiAgaWYgKCFmcmFtZXMpIHtcbiAgICBjb25zb2xlLmxvZygnW0ZhaWx1cmVdIGVycm9yIGNhcHR1cmluZyBmcmFtZXMnKTtcbiAgICByZXR1cm4gW107XG4gIH1cbiAgZm9yICh2YXIgaT0wOyBpIDwgZnJhbWVzLmxlbmd0aDsgaSsrKSB7XG4gICAgZm4gPSBmcmFtZXNbaV0uZ2V0RnVuY3Rpb24oKTtcbiAgICBpZiAoZm4gJiYgZm4gPT09IHNmZiB8fCBuYW1lICYmIG5hbWUgPT09IGZyYW1lc1tpXS5nZXRGdW5jdGlvbk5hbWUoKSkge1xuICAgICAgcmV0dXJuIGZyYW1lcy5zbGljZShpICsgMSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBmcmFtZXM7XG59XG5cbmZ1bmN0aW9uIHVud2luZCAoZnJhbWVzKSB7XG4gIHZhciByZXN1bHQgPSBbXTtcblxuICBmb3IgKHZhciBpPTAsIGZuOyBpIDwgZnJhbWVzLmxlbmd0aDsgaSsrKSB7XG4gICAgZm4gPSBmcmFtZXNbaV0uZ2V0RnVuY3Rpb24oKTtcblxuICAgIGlmICghZm4gfHwgIWZuWydmYWlsdXJlOmlnbm9yZSddKSB7XG4gICAgICByZXN1bHQucHVzaChmcmFtZXNbaV0pO1xuICAgIH1cblxuICAgIGlmIChmbiAmJiBmblsnZmFpbHVyZTpmcmFtZXMnXSkge1xuICAgICAgaWYgKEZhaWx1cmUuRlJBTUVfRU1QVFkpIHtcbiAgICAgICAgcmVzdWx0LnB1c2gobnVsbCk7XG4gICAgICB9XG5cbiAgICAgIC8vIENhbGwgdGhlIGdldHRlciBhbmQga2VlcCBhIHJlZmVyZW5jZSB0byB0aGUgcmVzdWx0IGluIGNhc2Ugd2UgaGF2ZSB0b1xuICAgICAgLy8gdW53aW5kIHRoZSBzYW1lIGZ1bmN0aW9uIGFub3RoZXIgdGltZS5cbiAgICAgIC8vIFRPRE86IE1ha2Ugc3VyZSBrZWVwaW5nIGEgcmVmZXJlbmNlIHRvIHRoZSBmcmFtZXMgZG9lc24ndCBjcmVhdGUgbGVha3NcbiAgICAgIGlmICh0eXBlb2YgZm5bJ2ZhaWx1cmU6ZnJhbWVzJ10gPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgdmFyIGdldHRlciA9IGZuWydmYWlsdXJlOmZyYW1lcyddO1xuICAgICAgICBmblsnZmFpbHVyZTpmcmFtZXMnXSA9IG51bGw7XG4gICAgICAgIGZuWydmYWlsdXJlOmZyYW1lcyddID0gZ2V0dGVyKCk7XG4gICAgICB9XG5cbiAgICAgIHJlc3VsdC5wdXNoLmFwcGx5KHJlc3VsdCwgdW53aW5kKGZuWydmYWlsdXJlOmZyYW1lcyddKSk7XG4gICAgICBicmVhaztcbiAgICB9XG4gIH1cblxuICByZXR1cm4gcmVzdWx0O1xufVxuXG4vLyBSZWNlaXZlciBmb3IgdGhlIGZyYW1lcyBpbiBhIC5zdGFjayBwcm9wZXJ0eSBmcm9tIGNhcHR1cmVTdGFja1RyYWNlXG52YXIgVjhGUkFNRVMgPSB7fTtcblxuLy8gVjggY29kZSBwYXRoIGZvciBnZW5lcmF0aW5nIGEgZnJhbWVzIGdldHRlclxuZnVuY3Rpb24gbWFrZUZyYW1lc0dldHRlclY4IChzZmYpIHtcbiAgTmF0aXZlRXJyb3IuY2FwdHVyZVN0YWNrVHJhY2UoVjhGUkFNRVMsIHNmZiB8fCBtYWtlRnJhbWVzR2V0dGVyVjgpO1xuICBzZmYgPSBudWxsO1xuICB2YXIgZnJhbWVzID0gVjhGUkFNRVMuc3RhY2s7XG4gIFY4RlJBTUVTLnN0YWNrID0gbnVsbDsgIC8vIElNUE9SVEFOVDogVGhpcyBpcyBuZWVkZWQgdG8gYXZvaWQgbGVha3MhISFcbiAgcmV0dXJuIGZ1bmN0aW9uIChjbGVhbnVwKSB7XG4gICAgdmFyIHJlc3VsdCA9IGZyYW1lcztcbiAgICAvLyBDbGVhbiB1cCBjbG9zdXJlIHZhcmlhYmxlcyB0byBoZWxwIEdDXG4gICAgZnJhbWVzID0gbnVsbDtcbiAgICByZXR1cm4gcmVzdWx0O1xuICB9O1xufVxuXG4vLyBub24tVjggY29kZSBwYXRoIGZvciBnZW5lcmF0aW5nIGEgZnJhbWVzIGdldHRlclxuZnVuY3Rpb24gbWFrZUZyYW1lc0dldHRlckNvbXBhdCAoc2ZmKSB7XG4gIC8vIE9idGFpbiBhIHN0YWNrIHRyYWNlIGF0IHRoZSBjdXJyZW50IHBvaW50XG4gIHZhciBlcnJvciA9IGdldEVycm9yV2l0aFN0YWNrKCk7XG5cbiAgLy8gV2FsayB0aGUgY2FsbGVyIGNoYWluIHRvIGFubm90YXRlIHRoZSBzdGFjayB3aXRoIGZ1bmN0aW9uIHJlZmVyZW5jZXNcbiAgLy8gR2l2ZW4gdGhlIGxpbWl0YXRpb25zIGltcG9zZWQgYnkgRVM1IFwic3RyaWN0IG1vZGVcIiBpdCdzIG5vdCBwb3NzaWJsZVxuICAvLyB0byBvYnRhaW4gcmVmZXJlbmNlcyB0byBmdW5jdGlvbnMgYmV5b25kIG9uZSB0aGF0IGlzIGRlZmluZWQgaW4gc3RyaWN0XG4gIC8vIG1vZGUuIEFsc28gbm90ZSB0aGF0IGFueSBraW5kIG9mIHJlY3Vyc2lvbiB3aWxsIG1ha2UgdGhlIHdhbGtlciB1bmFibGVcbiAgLy8gdG8gZ28gcGFzdCBpdC5cbiAgdmFyIGNhbGxlciA9IGFyZ3VtZW50cy5jYWxsZWU7XG4gIHZhciBmdW5jdGlvbnMgPSBbZ2V0RXJyb3JXaXRoU3RhY2tdO1xuICBmb3IgKHZhciBpPTA7IGNhbGxlciAmJiBpIDwgMTA7IGkrKykge1xuICAgIGZ1bmN0aW9ucy5wdXNoKGNhbGxlcik7XG4gICAgaWYgKGNhbGxlci5jYWxsZXIgPT09IGNhbGxlcikgYnJlYWs7XG4gICAgY2FsbGVyID0gY2FsbGVyLmNhbGxlcjtcbiAgfVxuICBjYWxsZXIgPSBudWxsO1xuXG4gIHJldHVybiBmdW5jdGlvbiAoY2xlYW51cCkge1xuICAgIHZhciBmcmFtZXMgPSBudWxsO1xuXG4gICAgaWYgKCFjbGVhbnVwKSB7XG4gICAgICAvLyBQYXJzZSB0aGUgc3RhY2sgdHJhY2VcbiAgICAgIGZyYW1lcyA9IEVycm9yU3RhY2tQYXJzZXIucGFyc2UoZXJyb3IpO1xuICAgICAgLy8gQXR0YWNoIGZ1bmN0aW9uIHJlZmVyZW5jZXMgdG8gdGhlIGZyYW1lcyAoc2tpcHBpbmcgdGhlIG1ha2VyIGZyYW1lcylcbiAgICAgIC8vIGFuZCBjcmVhdGluZyBDYWxsU2l0ZSBvYmplY3RzIGZvciBlYWNoIG9uZS5cbiAgICAgIGZvciAodmFyIGk9MjsgaSA8IGZyYW1lcy5sZW5ndGg7IGkrKykge1xuICAgICAgICBmcmFtZXNbaV0uZnVuY3Rpb24gPSBmdW5jdGlvbnNbaV07XG4gICAgICAgIGZyYW1lc1tpXSA9IG5ldyBDYWxsU2l0ZShmcmFtZXNbaV0pO1xuICAgICAgfVxuXG4gICAgICBmcmFtZXMgPSB0cmltKGZyYW1lcy5zbGljZSgyKSwgc2ZmKTtcbiAgICB9XG5cbiAgICAvLyBDbGVhbiB1cCBjbG9zdXJlIHZhcmlhYmxlcyB0byBoZWxwIEdDXG4gICAgc2ZmID0gbnVsbDtcbiAgICBlcnJvciA9IG51bGw7XG4gICAgZnVuY3Rpb25zID0gbnVsbDtcblxuICAgIHJldHVybiBmcmFtZXM7XG4gIH07XG59XG5cbi8vIEdlbmVyYXRlcyBhIGdldHRlciBmb3IgdGhlIGNhbGwgc2l0ZSBmcmFtZXNcbi8vIFRPRE86IElmIHdlIG9ic2VydmUgbGVha3Mgd2l0aCBjb21wbGV4IHVzZSBjYXNlcyAoZHVlIHRvIGNsb3N1cmUgc2NvcGVzKVxuLy8gICAgICAgd2UgY2FuIGdlbmVyYXRlIGhlcmUgb3VyIGNvbXBhdCBDYWxsU2l0ZSBvYmplY3RzIHN0b3JpbmcgdGhlIGZ1bmN0aW9uJ3Ncbi8vICAgICAgIHNvdXJjZSBjb2RlIGluc3RlYWQgb2YgYW4gYWN0dWFsIHJlZmVyZW5jZSB0byB0aGVtLCB0aGF0IHNob3VsZCBoZWxwXG4vLyAgICAgICB0aGUgR0Mgc2luY2Ugd2UnbGwgYmUganVzdCBrZWVwaW5nIGxpdGVyYWxzIGFyb3VuZC5cbnZhciBtYWtlRnJhbWVzR2V0dGVyID0gdHlwZW9mIE5hdGl2ZUVycm9yLmNhcHR1cmVTdGFja1RyYWNlID09PSAnZnVuY3Rpb24nXG4gICAgICAgICAgICAgICAgICAgICA/IG1ha2VGcmFtZXNHZXR0ZXJWOFxuICAgICAgICAgICAgICAgICAgICAgOiBtYWtlRnJhbWVzR2V0dGVyQ29tcGF0O1xuXG5cbi8vIE92ZXJyaWRlIFY4IHN0YWNrIHRyYWNlIGJ1aWxkZXIgdG8gaW5qZWN0IG91ciBsb2dpY1xudmFyIG9sZFByZXBhcmVTdGFja1RyYWNlID0gRXJyb3IucHJlcGFyZVN0YWNrVHJhY2U7XG5FcnJvci5wcmVwYXJlU3RhY2tUcmFjZSA9IGZ1bmN0aW9uIChlcnJvciwgZnJhbWVzKSB7XG4gIC8vIFdoZW4gY2FsbGVkIGZyb20gbWFrZUZyYW1lc0dldHRlciB3ZSBqdXN0IHdhbnQgdG8gb2J0YWluIHRoZSBmcmFtZXNcbiAgaWYgKGVycm9yID09PSBWOEZSQU1FUykge1xuICAgIHJldHVybiBmcmFtZXM7XG4gIH1cblxuICAvLyBGb3J3YXJkIHRvIGFueSBwcmV2aW91c2x5IGRlZmluZWQgYmVoYXZpb3VyXG4gIGlmIChvbGRQcmVwYXJlU3RhY2tUcmFjZSkge1xuICAgIHJldHVybiBvbGRQcmVwYXJlU3RhY2tUcmFjZS5jYWxsKEVycm9yLCBlcnJvciwgZnJhbWVzKTtcbiAgfVxuXG4gIC8vIEVtdWxhdGUgZGVmYXVsdCBiZWhhdmlvdXIgKHdpdGggbG9uZy10cmFjZXMpXG4gIHJldHVybiBGYWlsdXJlLnByb3RvdHlwZS5wcmVwYXJlU3RhY2tUcmFjZS5jYWxsKGVycm9yLCB1bndpbmQoZnJhbWVzKSk7XG59O1xuXG4vLyBBdHRhY2ggYSBuZXcgZXhjbHVzaW9uIHByZWRpY2F0ZSBmb3IgZnJhbWVzXG5mdW5jdGlvbiBleGNsdWRlIChjdG9yLCBwcmVkaWNhdGUpIHtcbiAgdmFyIGZuID0gcHJlZGljYXRlO1xuXG4gIGlmICh0eXBlb2YgcHJlZGljYXRlID09PSAnc3RyaW5nJykge1xuICAgIGZuID0gZnVuY3Rpb24gKGZyYW1lKSB7XG4gICAgICByZXR1cm4gLTEgIT09IGZyYW1lLmdldEZpbGVOYW1lKCkuaW5kZXhPZihwcmVkaWNhdGUpO1xuICAgIH07XG4gIH0gZWxzZSBpZiAodHlwZW9mIHByZWRpY2F0ZS50ZXN0ID09PSAnZnVuY3Rpb24nKSB7XG4gICAgZm4gPSBmdW5jdGlvbiAoZnJhbWUpIHtcbiAgICAgIHJldHVybiBwcmVkaWNhdGUudGVzdChmcmFtZS5nZXRGaWxlTmFtZSgpKTtcbiAgICB9O1xuICB9XG5cbiAgY3Rvci5leGNsdWRlcy5wdXNoKGZuKTtcbn1cblxuLy8gRXhwb3NlIHRoZSBmaWx0ZXIgaW4gdGhlIHJvb3QgRmFpbHVyZSB0eXBlXG5GYWlsdXJlLmV4Y2x1ZGVzID0gW107XG5GYWlsdXJlLmV4Y2x1ZGUgPSBmdW5jdGlvbiBGYWlsdXJlX2V4Y2x1ZGUgKHByZWRpY2F0ZSkge1xuICBleGNsdWRlKEZhaWx1cmUsIHByZWRpY2F0ZSk7XG59O1xuXG4vLyBBdHRhY2ggYSBmcmFtZXMgZ2V0dGVyIHRvIHRoZSBmdW5jdGlvbiBzbyB3ZSBjYW4gcmUtY29uc3RydWN0IGFzeW5jIHN0YWNrcy5cbi8vXG4vLyBOb3RlIHRoYXQgdGhpcyBqdXN0IGF1Z21lbnRzIHRoZSBmdW5jdGlvbiB3aXRoIHRoZSBuZXcgcHJvcGVydHksIGl0IGRvZXNuJ3Rcbi8vIGNyZWF0ZSBhIHdyYXBwZXIgZXZlcnkgdGltZSBpdCdzIGNhbGxlZCwgc28gdXNpbmcgaXQgbXVsdGlwbGUgdGltZXMgb24gdGhlXG4vLyBzYW1lIGZ1bmN0aW9uIHdpbGwgaW5kZWVkIG92ZXJ3cml0ZSB0aGUgcHJldmlvdXMgdHJhY2tpbmcgaW5mb3JtYXRpb24uIFRoaXNcbi8vIGlzIGludGVuZGVkIHNpbmNlIGl0J3MgZmFzdGVyIGFuZCBtb3JlIGltcG9ydGFudGx5IGRvZXNuJ3QgYnJlYWsgc29tZSBBUElzXG4vLyB1c2luZyBjYWxsYmFjayByZWZlcmVuY2VzIHRvIHVucmVnaXN0ZXIgdGhlbSBmb3IgaW5zdGFuY2UuXG4vLyBXaGVuIHlvdSB3YW50IHRvIHVzZSB0aGUgc2FtZSBmdW5jdGlvbiB3aXRoIGRpZmZlcmVudCB0cmFja2luZyBpbmZvcm1hdGlvblxuLy8ganVzdCB1c2UgRmFpbHVyZS53cmFwKCkuXG4vL1xuLy8gVGhlIHRyYWNraW5nIGNhbiBiZSBnbG9iYWxseSBkaXNhYmxlZCBieSBzZXR0aW5nIEZhaWx1cmUuVFJBQ0sgdG8gZmFsc2VcbkZhaWx1cmUudHJhY2sgPSBmdW5jdGlvbiBGYWlsdXJlX3RyYWNrIChmbiwgc2ZmKSB7XG4gIGlmICh0eXBlb2YgZm4gIT09ICdmdW5jdGlvbicpIHtcbiAgICByZXR1cm4gZm47XG4gIH1cblxuICAvLyBDbGVhbiB1cCBwcmV2aW91cyBmcmFtZXMgdG8gaGVscCB0aGUgR0NcbiAgaWYgKHR5cGVvZiBmblsnZmFpbHVyZTpmcmFtZXMnXSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIGZuWydmYWlsdXJlOmZyYW1lcyddKHRydWUpO1xuICB9XG5cbiAgaWYgKEZhaWx1cmUuVFJBQ0spIHtcbiAgICBmblsnZmFpbHVyZTpmcmFtZXMnXSA9IG51bGw7XG4gICAgZm5bJ2ZhaWx1cmU6ZnJhbWVzJ10gPSBtYWtlRnJhbWVzR2V0dGVyKHNmZiB8fCBGYWlsdXJlX3RyYWNrKTtcbiAgfVxuXG4gIHJldHVybiBmbjtcbn07XG5cbi8vIFdyYXBzIHRoZSBmdW5jdGlvbiBiZWZvcmUgYW5ub3RhdGluZyBpdCB3aXRoIHRyYWNraW5nIGluZm9ybWF0aW9uLCB0aGlzXG4vLyBhbGxvd3MgdG8gdHJhY2sgbXVsdGlwbGUgc2NoZWR1bGxpbmdzIG9mIGEgc2luZ2xlIGZ1bmN0aW9uLlxuRmFpbHVyZS53cmFwID0gZnVuY3Rpb24gRmFpbHVyZV93cmFwIChmbikge1xuICB2YXIgd3JhcHBlciA9IEZhaWx1cmUuaWdub3JlKGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gZm4uYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgfSk7XG5cbiAgcmV0dXJuIEZhaWx1cmUudHJhY2sod3JhcHBlciwgRmFpbHVyZV93cmFwKTtcbn07XG5cbi8vIE1hcmsgYSBmdW5jdGlvbiB0byBiZSBpZ25vcmVkIHdoZW4gZ2VuZXJhdGluZyBzdGFjayB0cmFjZXNcbkZhaWx1cmUuaWdub3JlID0gZnVuY3Rpb24gRmFpbHVyZV9pZ25vcmUgKGZuKSB7XG4gIGZuWydmYWlsdXJlOmlnbm9yZSddID0gdHJ1ZTtcbiAgcmV0dXJuIGZuO1xufTtcblxuRmFpbHVyZS5zZXRUaW1lb3V0ID0gZnVuY3Rpb24gRmFpbHVyZV9zZXRUaW1lb3V0ICgpIHtcbiAgYXJndW1lbnRzWzBdID0gRmFpbHVyZS50cmFjayhhcmd1bWVudHNbMF0sIEZhaWx1cmVfc2V0VGltZW91dCk7XG4gIHJldHVybiBzZXRUaW1lb3V0LmFwcGx5KG51bGwsIGFyZ3VtZW50cyk7XG59O1xuXG5GYWlsdXJlLm5leHRUaWNrID0gZnVuY3Rpb24gRmFpbHVyZV9uZXh0VGljayAoKSB7XG4gIGFyZ3VtZW50c1swXSA9IEZhaWx1cmUudHJhY2soYXJndW1lbnRzWzBdLCBGYWlsdXJlX25leHRUaWNrKTtcbiAgcmV0dXJuIHByb2Nlc3MubmV4dFRpY2suYXBwbHkocHJvY2VzcywgYXJndW1lbnRzKTtcbn07XG5cbkZhaWx1cmUucGF0Y2ggPSBmdW5jdGlvbiBGYWlsdXJlX3BhdGNoKG9iaiwgbmFtZSwgaWR4KSB7XG4gIGlmIChvYmogJiYgdHlwZW9mIG9ialtuYW1lXSAhPT0gJ2Z1bmN0aW9uJykge1xuICAgIHRocm93IG5ldyBFcnJvcignT2JqZWN0IGRvZXMgbm90IGhhdmUgYSBcIicgKyBuYW1lICsgJ1wiIG1ldGhvZCcpO1xuICB9XG5cbiAgdmFyIG9yaWdpbmFsID0gb2JqW25hbWVdO1xuXG4gIC8vIFdoZW4gdGhlIGV4YWN0IGFyZ3VtZW50IGluZGV4IGlzIHByb3ZpZGVkIHVzZSBhbiBvcHRpbWl6ZWQgY29kZSBwYXRoXG4gIGlmICh0eXBlb2YgaWR4ID09PSAnbnVtYmVyJykge1xuXG4gICAgb2JqW25hbWVdID0gZnVuY3Rpb24gKCkge1xuICAgICAgYXJndW1lbnRzW2lkeF0gPSBGYWlsdXJlLnRyYWNrKGFyZ3VtZW50c1tpZHhdLCBvYmpbbmFtZV0pO1xuICAgICAgcmV0dXJuIG9yaWdpbmFsLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gICAgfTtcblxuICAvLyBPdGhlcndpc2UgZGV0ZWN0IHRoZSBmdW5jdGlvbnMgdG8gdHJhY2sgYXQgaW52b2thdGlvbiB0aW1lXG4gIH0gZWxzZSB7XG5cbiAgICBvYmpbbmFtZV0gPSBmdW5jdGlvbiAoKSB7XG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGFyZ3VtZW50cy5sZW5ndGg7IGkrKykge1xuICAgICAgICBpZiAodHlwZW9mIGFyZ3VtZW50c1tpXSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgIGFyZ3VtZW50c1tpXSA9IEZhaWx1cmUudHJhY2soYXJndW1lbnRzW2ldLCBvYmpbbmFtZV0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXR1cm4gb3JpZ2luYWwuYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgICB9O1xuXG4gIH1cblxuICAvLyBBdWdtZW50IHRoZSB3cmFwcGVyIHdpdGggYW55IHByb3BlcnRpZXMgZnJvbSB0aGUgb3JpZ2luYWxcbiAgZm9yICh2YXIgayBpbiBvcmlnaW5hbCkgaWYgKG9yaWdpbmFsLmhhc093blByb3BlcnR5KGspKSB7XG4gICAgb2JqW25hbWVdW2tdID0gb3JpZ2luYWxba107XG4gIH1cblxuICByZXR1cm4gb2JqW25hbWVdO1xufTtcblxuLy8gSGVscGVyIHRvIGNyZWF0ZSBuZXcgRmFpbHVyZSB0eXBlc1xuRmFpbHVyZS5jcmVhdGUgPSBmdW5jdGlvbiAobmFtZSwgcHJvcHMpIHtcbiAgaWYgKHR5cGVvZiBuYW1lICE9PSAnc3RyaW5nJykge1xuICAgIHRocm93IG5ldyBGYWlsdXJlKCdFeHBlY3RlZCBhIG5hbWUgYXMgZmlyc3QgYXJndW1lbnQnKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGN0b3IgKG1lc3NhZ2UsIHNmZikge1xuICAgIGlmICghKHRoaXMgaW5zdGFuY2VvZiBGYWlsdXJlKSkge1xuICAgICAgcmV0dXJuIG5ldyBjdG9yKG1lc3NhZ2UsIHNmZik7XG4gICAgfVxuICAgIEZhaWx1cmUuYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgfVxuXG4gIC8vIEF1Z21lbnQgY29uc3RydWN0b3JcbiAgY3Rvci5leGNsdWRlcyA9IFtdO1xuICBjdG9yLmV4Y2x1ZGUgPSBmdW5jdGlvbiAocHJlZGljYXRlKSB7XG4gICAgZXhjbHVkZShjdG9yLCBwcmVkaWNhdGUpO1xuICB9O1xuXG4gIGN0b3IucHJvdG90eXBlID0gT2JqZWN0LmNyZWF0ZShGYWlsdXJlLnByb3RvdHlwZSk7XG4gIGN0b3IucHJvdG90eXBlLmNvbnN0cnVjdG9yID0gY3RvcjtcbiAgY3Rvci5wcm90b3R5cGUubmFtZSA9IG5hbWU7XG4gIGlmICh0eXBlb2YgcHJvcHMgPT09ICdmdW5jdGlvbicpIHtcbiAgICBjdG9yLnByb3RvdHlwZS5wcmVwYXJlU3RhY2tUcmFjZSA9IHByb3BzO1xuICB9IGVsc2UgaWYgKHByb3BzKSB7XG4gICAgT2JqZWN0LmtleXMocHJvcHMpLmZvckVhY2goZnVuY3Rpb24gKHByb3ApIHtcbiAgICAgIGN0b3IucHJvdG90eXBlW3Byb3BdID0gcHJvcDtcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gY3Rvcjtcbn07XG5cbnZhciBidWlsdGluRXJyb3JUeXBlcyA9IFtcbiAgJ0Vycm9yJywgJ1R5cGVFcnJvcicsICdSYW5nZUVycm9yJywgJ1JlZmVyZW5jZUVycm9yJywgJ1N5bnRheEVycm9yJyxcbiAgJ0V2YWxFcnJvcicsICdVUklFcnJvcicsICdJbnRlcm5hbEVycm9yJ1xuXTtcbnZhciBidWlsdGluRXJyb3JzID0ge307XG5cbkZhaWx1cmUuaW5zdGFsbCA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIHJvb3QgPSB0eXBlb2Ygd2luZG93ID09PSAnb2JqZWN0JyA/IHdpbmRvdyA6IGdsb2JhbDtcblxuICBidWlsdGluRXJyb3JUeXBlcy5mb3JFYWNoKGZ1bmN0aW9uICh0eXBlKSB7XG4gICAgaWYgKHJvb3RbdHlwZV0gJiYgIWJ1aWx0aW5FcnJvcnNbdHlwZV0pIHtcbiAgICAgIGJ1aWx0aW5FcnJvcnNbdHlwZV0gPSByb290W3R5cGVdO1xuICAgICAgcm9vdFt0eXBlXSA9IEZhaWx1cmUuY3JlYXRlKHR5cGUpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gQWxsb3cgdXNhZ2U6IHZhciBGYWlsdXJlID0gcmVxdWlyZSgnZmFpbHVyZScpLmluc3RhbGwoKVxuICByZXR1cm4gRmFpbHVyZTtcbn07XG5cbkZhaWx1cmUudW5pbnN0YWxsID0gZnVuY3Rpb24gKCkge1xuICBidWlsdGluRXJyb3JUeXBlcy5mb3JFYWNoKGZ1bmN0aW9uICh0eXBlKSB7XG4gICAgcm9vdFt0eXBlXSA9IGJ1aWx0aW5FcnJvcnNbdHlwZV0gfHwgcm9vdFt0eXBlXTtcbiAgfSk7XG59O1xuXG5cbnZhciBwcm90byA9IEZhaWx1cmUucHJvdG90eXBlID0gT2JqZWN0LmNyZWF0ZShFcnJvci5wcm90b3R5cGUpO1xucHJvdG8uY29uc3RydWN0b3IgPSBGYWlsdXJlO1xuXG5wcm90by5uYW1lID0gJ0ZhaWx1cmUnO1xucHJvdG8ubWVzc2FnZSA9ICcnO1xuXG5pZiAodHlwZW9mIE9iamVjdC5kZWZpbmVQcm9wZXJ0eSA9PT0gJ2Z1bmN0aW9uJykge1xuICBPYmplY3QuZGVmaW5lUHJvcGVydHkocHJvdG8sICdmcmFtZXMnLCB7XG4gICAgZ2V0OiBmdW5jdGlvbiAoKSB7XG4gICAgICAvLyBVc2UgdHJpbW1pbmcganVzdCBpbiBjYXNlIHRoZSBzZmYgd2FzIGRlZmluZWQgYWZ0ZXIgY29uc3RydWN0aW5nXG4gICAgICB2YXIgZnJhbWVzID0gdW53aW5kKHRyaW0odGhpcy5fZ2V0RnJhbWVzKCksIHRoaXMuc2ZmKSk7XG5cbiAgICAgIC8vIENhY2hlIG5leHQgYWNjZXNzZXMgdG8gdGhlIHByb3BlcnR5XG4gICAgICBPYmplY3QuZGVmaW5lUHJvcGVydHkodGhpcywgJ2ZyYW1lcycsIHtcbiAgICAgICAgdmFsdWU6IGZyYW1lcyxcbiAgICAgICAgd3JpdGFibGU6IHRydWVcbiAgICAgIH0pO1xuXG4gICAgICAvLyBDbGVhbiB1cCB0aGUgZ2V0dGVyIGNsb3N1cmVcbiAgICAgIHRoaXMuX2dldEZyYW1lcyA9IG51bGw7XG5cbiAgICAgIHJldHVybiBmcmFtZXM7XG4gICAgfVxuICB9KTtcblxuICBPYmplY3QuZGVmaW5lUHJvcGVydHkocHJvdG8sICdzdGFjaycsIHtcbiAgICBnZXQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgIHJldHVybiB0aGlzLmdlbmVyYXRlU3RhY2tUcmFjZSgpO1xuICAgIH1cbiAgfSk7XG59XG5cbnByb3RvLmdlbmVyYXRlU3RhY2tUcmFjZSA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIGV4Y2x1ZGVzID0gdGhpcy5jb25zdHJ1Y3Rvci5leGNsdWRlcztcbiAgdmFyIGluY2x1ZGUsIGZyYW1lcyA9IFtdO1xuXG4gIC8vIFNwZWNpZmljIHByb3RvdHlwZXMgaW5oZXJpdCB0aGUgZXhjbHVkZXMgZnJvbSBGYWlsdXJlXG4gIGlmIChleGNsdWRlcyAhPT0gRmFpbHVyZS5leGNsdWRlcykge1xuICAgIGV4Y2x1ZGVzLnB1c2guYXBwbHkoZXhjbHVkZXMsIEZhaWx1cmUuZXhjbHVkZXMpO1xuICB9XG5cbiAgLy8gQXBwbHkgZmlsdGVyaW5nXG4gIGZvciAodmFyIGk9MDsgaSA8IHRoaXMuZnJhbWVzLmxlbmd0aDsgaSsrKSB7XG4gICAgaW5jbHVkZSA9IHRydWU7XG4gICAgaWYgKHRoaXMuZnJhbWVzW2ldKSB7XG4gICAgICBmb3IgKHZhciBqPTA7IGluY2x1ZGUgJiYgaiA8IGV4Y2x1ZGVzLmxlbmd0aDsgaisrKSB7XG4gICAgICAgIGluY2x1ZGUgJj0gIWV4Y2x1ZGVzW2pdLmNhbGwodGhpcywgdGhpcy5mcmFtZXNbaV0pO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAoaW5jbHVkZSkge1xuICAgICAgZnJhbWVzLnB1c2godGhpcy5mcmFtZXNbaV0pO1xuICAgIH1cbiAgfVxuXG4gIC8vIEhvbm9yIGFueSBwcmV2aW91c2x5IGRlZmluZWQgc3RhY2t0cmFjZSBmb3JtYXR0ZXIgYnlcbiAgLy8gYWxsb3dpbmcgaXQgZmluYWxseSBmb3JtYXQgdGhlIGZyYW1lcy4gVGhpcyBpcyBuZWVkZWRcbiAgLy8gd2hlbiB1c2luZyBub2RlLXNvdXJjZS1tYXAtc3VwcG9ydCBmb3IgaW5zdGFuY2UuXG4gIC8vIFRPRE86IENhbiB3ZSBtYXAgdGhlIFwibnVsbFwiIGZyYW1lcyB0byBhIENhbGxGcmFtZSBzaGltP1xuICBpZiAob2xkUHJlcGFyZVN0YWNrVHJhY2UpIHtcbiAgICBmcmFtZXMgPSBmcmFtZXMuZmlsdGVyKGZ1bmN0aW9uICh4KSB7IHJldHVybiAhIXg7IH0pO1xuICAgIHJldHVybiBvbGRQcmVwYXJlU3RhY2tUcmFjZS5jYWxsKEVycm9yLCB0aGlzLCBmcmFtZXMpO1xuICB9XG5cbiAgcmV0dXJuIHRoaXMucHJlcGFyZVN0YWNrVHJhY2UoZnJhbWVzKTtcbn07XG5cbnByb3RvLnByZXBhcmVTdGFja1RyYWNlID0gZnVuY3Rpb24gKGZyYW1lcykge1xuICB2YXIgbGluZXMgPSBbdGhpc107XG4gIGZvciAodmFyIGk9MDsgaSA8IGZyYW1lcy5sZW5ndGg7IGkrKykge1xuICAgIGxpbmVzLnB1c2goXG4gICAgICBmcmFtZXNbaV0gPyBGYWlsdXJlLkZSQU1FX1BSRUZJWCArIGZyYW1lc1tpXSA6IEZhaWx1cmUuRlJBTUVfRU1QVFlcbiAgICApO1xuICB9XG4gIHJldHVybiBsaW5lcy5qb2luKCdcXG4nKTtcbn07XG5cblxubW9kdWxlLmV4cG9ydHMgPSBGYWlsdXJlO1xuIiwidmFyIEZhaWx1cmUgPSByZXF1aXJlKCcuL2xpYi9mYWlsdXJlJyk7XG5cbm1vZHVsZS5leHBvcnRzID0gRmFpbHVyZTtcbiIsIi8vIHNoaW0gZm9yIHVzaW5nIHByb2Nlc3MgaW4gYnJvd3NlclxuXG52YXIgcHJvY2VzcyA9IG1vZHVsZS5leHBvcnRzID0ge307XG5cbnByb2Nlc3MubmV4dFRpY2sgPSAoZnVuY3Rpb24gKCkge1xuICAgIHZhciBjYW5TZXRJbW1lZGlhdGUgPSB0eXBlb2Ygd2luZG93ICE9PSAndW5kZWZpbmVkJ1xuICAgICYmIHdpbmRvdy5zZXRJbW1lZGlhdGU7XG4gICAgdmFyIGNhbk11dGF0aW9uT2JzZXJ2ZXIgPSB0eXBlb2Ygd2luZG93ICE9PSAndW5kZWZpbmVkJ1xuICAgICYmIHdpbmRvdy5NdXRhdGlvbk9ic2VydmVyO1xuICAgIHZhciBjYW5Qb3N0ID0gdHlwZW9mIHdpbmRvdyAhPT0gJ3VuZGVmaW5lZCdcbiAgICAmJiB3aW5kb3cucG9zdE1lc3NhZ2UgJiYgd2luZG93LmFkZEV2ZW50TGlzdGVuZXJcbiAgICA7XG5cbiAgICBpZiAoY2FuU2V0SW1tZWRpYXRlKSB7XG4gICAgICAgIHJldHVybiBmdW5jdGlvbiAoZikgeyByZXR1cm4gd2luZG93LnNldEltbWVkaWF0ZShmKSB9O1xuICAgIH1cblxuICAgIHZhciBxdWV1ZSA9IFtdO1xuXG4gICAgaWYgKGNhbk11dGF0aW9uT2JzZXJ2ZXIpIHtcbiAgICAgICAgdmFyIGhpZGRlbkRpdiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICAgIHZhciBvYnNlcnZlciA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHZhciBxdWV1ZUxpc3QgPSBxdWV1ZS5zbGljZSgpO1xuICAgICAgICAgICAgcXVldWUubGVuZ3RoID0gMDtcbiAgICAgICAgICAgIHF1ZXVlTGlzdC5mb3JFYWNoKGZ1bmN0aW9uIChmbikge1xuICAgICAgICAgICAgICAgIGZuKCk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgb2JzZXJ2ZXIub2JzZXJ2ZShoaWRkZW5EaXYsIHsgYXR0cmlidXRlczogdHJ1ZSB9KTtcblxuICAgICAgICByZXR1cm4gZnVuY3Rpb24gbmV4dFRpY2soZm4pIHtcbiAgICAgICAgICAgIGlmICghcXVldWUubGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgaGlkZGVuRGl2LnNldEF0dHJpYnV0ZSgneWVzJywgJ25vJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBxdWV1ZS5wdXNoKGZuKTtcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICBpZiAoY2FuUG9zdCkge1xuICAgICAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcignbWVzc2FnZScsIGZ1bmN0aW9uIChldikge1xuICAgICAgICAgICAgdmFyIHNvdXJjZSA9IGV2LnNvdXJjZTtcbiAgICAgICAgICAgIGlmICgoc291cmNlID09PSB3aW5kb3cgfHwgc291cmNlID09PSBudWxsKSAmJiBldi5kYXRhID09PSAncHJvY2Vzcy10aWNrJykge1xuICAgICAgICAgICAgICAgIGV2LnN0b3BQcm9wYWdhdGlvbigpO1xuICAgICAgICAgICAgICAgIGlmIChxdWV1ZS5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgICAgIHZhciBmbiA9IHF1ZXVlLnNoaWZ0KCk7XG4gICAgICAgICAgICAgICAgICAgIGZuKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9LCB0cnVlKTtcblxuICAgICAgICByZXR1cm4gZnVuY3Rpb24gbmV4dFRpY2soZm4pIHtcbiAgICAgICAgICAgIHF1ZXVlLnB1c2goZm4pO1xuICAgICAgICAgICAgd2luZG93LnBvc3RNZXNzYWdlKCdwcm9jZXNzLXRpY2snLCAnKicpO1xuICAgICAgICB9O1xuICAgIH1cblxuICAgIHJldHVybiBmdW5jdGlvbiBuZXh0VGljayhmbikge1xuICAgICAgICBzZXRUaW1lb3V0KGZuLCAwKTtcbiAgICB9O1xufSkoKTtcblxucHJvY2Vzcy50aXRsZSA9ICdicm93c2VyJztcbnByb2Nlc3MuYnJvd3NlciA9IHRydWU7XG5wcm9jZXNzLmVudiA9IHt9O1xucHJvY2Vzcy5hcmd2ID0gW107XG5cbmZ1bmN0aW9uIG5vb3AoKSB7fVxuXG5wcm9jZXNzLm9uID0gbm9vcDtcbnByb2Nlc3MuYWRkTGlzdGVuZXIgPSBub29wO1xucHJvY2Vzcy5vbmNlID0gbm9vcDtcbnByb2Nlc3Mub2ZmID0gbm9vcDtcbnByb2Nlc3MucmVtb3ZlTGlzdGVuZXIgPSBub29wO1xucHJvY2Vzcy5yZW1vdmVBbGxMaXN0ZW5lcnMgPSBub29wO1xucHJvY2Vzcy5lbWl0ID0gbm9vcDtcblxucHJvY2Vzcy5iaW5kaW5nID0gZnVuY3Rpb24gKG5hbWUpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ3Byb2Nlc3MuYmluZGluZyBpcyBub3Qgc3VwcG9ydGVkJyk7XG59O1xuXG4vLyBUT0RPKHNodHlsbWFuKVxucHJvY2Vzcy5jd2QgPSBmdW5jdGlvbiAoKSB7IHJldHVybiAnLycgfTtcbnByb2Nlc3MuY2hkaXIgPSBmdW5jdGlvbiAoZGlyKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdwcm9jZXNzLmNoZGlyIGlzIG5vdCBzdXBwb3J0ZWQnKTtcbn07XG4iLCIoZnVuY3Rpb24gKHJvb3QsIGZhY3RvcnkpIHtcbiAgICAndXNlIHN0cmljdCc7XG4gICAgLy8gVW5pdmVyc2FsIE1vZHVsZSBEZWZpbml0aW9uIChVTUQpIHRvIHN1cHBvcnQgQU1ELCBDb21tb25KUy9Ob2RlLmpzLCBSaGlubywgYW5kIGJyb3dzZXJzLlxuICAgIGlmICh0eXBlb2YgZGVmaW5lID09PSAnZnVuY3Rpb24nICYmIGRlZmluZS5hbWQpIHtcbiAgICAgICAgZGVmaW5lKCdlcnJvci1zdGFjay1wYXJzZXInLCBbJ3N0YWNrZnJhbWUnXSwgZmFjdG9yeSk7XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgZXhwb3J0cyA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgbW9kdWxlLmV4cG9ydHMgPSBmYWN0b3J5KHJlcXVpcmUoJ3N0YWNrZnJhbWUnKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgcm9vdC5FcnJvclN0YWNrUGFyc2VyID0gZmFjdG9yeShyb290LlN0YWNrRnJhbWUpO1xuICAgIH1cbn0odGhpcywgZnVuY3Rpb24gRXJyb3JTdGFja1BhcnNlcihTdGFja0ZyYW1lKSB7XG4gICAgJ3VzZSBzdHJpY3QnO1xuXG4gICAgLy8gRVM1IFBvbHlmaWxsc1xuICAgIC8vIFNlZSBodHRwczovL2RldmVsb3Blci5tb3ppbGxhLm9yZy9lbi1VUy9kb2NzL1dlYi9KYXZhU2NyaXB0L1JlZmVyZW5jZS9HbG9iYWxfT2JqZWN0cy9BcnJheS9tYXBcbiAgICBpZiAoIUFycmF5LnByb3RvdHlwZS5tYXApIHtcbiAgICAgICAgQXJyYXkucHJvdG90eXBlLm1hcCA9IGZ1bmN0aW9uKGNhbGxiYWNrLCB0aGlzQXJnKSB7XG4gICAgICAgICAgICB2YXIgTyA9IE9iamVjdCh0aGlzKTtcbiAgICAgICAgICAgIHZhciBsZW4gPSBPLmxlbmd0aCA+Pj4gMDtcbiAgICAgICAgICAgIHZhciBUO1xuICAgICAgICAgICAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPiAxKSB7XG4gICAgICAgICAgICAgICAgVCA9IHRoaXNBcmc7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHZhciBBID0gbmV3IEFycmF5KGxlbik7XG4gICAgICAgICAgICB2YXIgayA9IDA7XG5cbiAgICAgICAgICAgIHdoaWxlIChrIDwgbGVuKSB7XG4gICAgICAgICAgICAgICAgdmFyIGtWYWx1ZSwgbWFwcGVkVmFsdWU7XG4gICAgICAgICAgICAgICAgaWYgKGsgaW4gTykge1xuICAgICAgICAgICAgICAgICAgICBrVmFsdWUgPSBPW2tdO1xuICAgICAgICAgICAgICAgICAgICBtYXBwZWRWYWx1ZSA9IGNhbGxiYWNrLmNhbGwoVCwga1ZhbHVlLCBrLCBPKTtcbiAgICAgICAgICAgICAgICAgICAgQVtrXSA9IG1hcHBlZFZhbHVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBrKys7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBBO1xuICAgICAgICB9O1xuICAgIH1cblxuICAgIC8vIFNlZSBodHRwczovL2RldmVsb3Blci5tb3ppbGxhLm9yZy9lbi1VUy9kb2NzL1dlYi9KYXZhU2NyaXB0L1JlZmVyZW5jZS9HbG9iYWxfT2JqZWN0cy9BcnJheS9maWx0ZXJcbiAgICBpZiAoIUFycmF5LnByb3RvdHlwZS5maWx0ZXIpIHtcbiAgICAgICAgQXJyYXkucHJvdG90eXBlLmZpbHRlciA9IGZ1bmN0aW9uKGNhbGxiYWNrLyosIHRoaXNBcmcqLykge1xuICAgICAgICAgICAgdmFyIHQgPSBPYmplY3QodGhpcyk7XG4gICAgICAgICAgICB2YXIgbGVuID0gdC5sZW5ndGggPj4+IDA7XG5cbiAgICAgICAgICAgIHZhciByZXMgPSBbXTtcbiAgICAgICAgICAgIHZhciB0aGlzQXJnID0gYXJndW1lbnRzLmxlbmd0aCA+PSAyID8gYXJndW1lbnRzWzFdIDogdm9pZCAwO1xuICAgICAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsZW47IGkrKykge1xuICAgICAgICAgICAgICAgIGlmIChpIGluIHQpIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIHZhbCA9IHRbaV07XG4gICAgICAgICAgICAgICAgICAgIGlmIChjYWxsYmFjay5jYWxsKHRoaXNBcmcsIHZhbCwgaSwgdCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlcy5wdXNoKHZhbCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiByZXM7XG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgdmFyIEZJUkVGT1hfU0FGQVJJX1NUQUNLX1JFR0VYUCA9IC9cXFMrXFw6XFxkKy87XG4gICAgdmFyIENIUk9NRV9JRV9TVEFDS19SRUdFWFAgPSAvXFxzK2F0IC87XG5cbiAgICByZXR1cm4ge1xuICAgICAgICAvKipcbiAgICAgICAgICogR2l2ZW4gYW4gRXJyb3Igb2JqZWN0LCBleHRyYWN0IHRoZSBtb3N0IGluZm9ybWF0aW9uIGZyb20gaXQuXG4gICAgICAgICAqIEBwYXJhbSBlcnJvciB7RXJyb3J9XG4gICAgICAgICAqIEByZXR1cm4gQXJyYXlbU3RhY2tGcmFtZV1cbiAgICAgICAgICovXG4gICAgICAgIHBhcnNlOiBmdW5jdGlvbiBFcnJvclN0YWNrUGFyc2VyJCRwYXJzZShlcnJvcikge1xuICAgICAgICAgICAgaWYgKHR5cGVvZiBlcnJvci5zdGFja3RyYWNlICE9PSAndW5kZWZpbmVkJyB8fCB0eXBlb2YgZXJyb3JbJ29wZXJhI3NvdXJjZWxvYyddICE9PSAndW5kZWZpbmVkJykge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLnBhcnNlT3BlcmEoZXJyb3IpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChlcnJvci5zdGFjayAmJiBlcnJvci5zdGFjay5tYXRjaChDSFJPTUVfSUVfU1RBQ0tfUkVHRVhQKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLnBhcnNlVjhPcklFKGVycm9yKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoZXJyb3Iuc3RhY2sgJiYgZXJyb3Iuc3RhY2subWF0Y2goRklSRUZPWF9TQUZBUklfU1RBQ0tfUkVHRVhQKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLnBhcnNlRkZPclNhZmFyaShlcnJvcik7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignQ2Fubm90IHBhcnNlIGdpdmVuIEVycm9yIG9iamVjdCcpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LFxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBTZXBhcmF0ZSBsaW5lIGFuZCBjb2x1bW4gbnVtYmVycyBmcm9tIGEgVVJMLWxpa2Ugc3RyaW5nLlxuICAgICAgICAgKiBAcGFyYW0gdXJsTGlrZSBTdHJpbmdcbiAgICAgICAgICogQHJldHVybiBBcnJheVtTdHJpbmddXG4gICAgICAgICAqL1xuICAgICAgICBleHRyYWN0TG9jYXRpb246IGZ1bmN0aW9uIEVycm9yU3RhY2tQYXJzZXIkJGV4dHJhY3RMb2NhdGlvbih1cmxMaWtlKSB7XG4gICAgICAgICAgICB2YXIgbG9jYXRpb25QYXJ0cyA9IHVybExpa2Uuc3BsaXQoJzonKTtcbiAgICAgICAgICAgIHZhciBsYXN0TnVtYmVyID0gbG9jYXRpb25QYXJ0cy5wb3AoKTtcbiAgICAgICAgICAgIHZhciBwb3NzaWJsZU51bWJlciA9IGxvY2F0aW9uUGFydHNbbG9jYXRpb25QYXJ0cy5sZW5ndGggLSAxXTtcbiAgICAgICAgICAgIGlmICghaXNOYU4ocGFyc2VGbG9hdChwb3NzaWJsZU51bWJlcikpICYmIGlzRmluaXRlKHBvc3NpYmxlTnVtYmVyKSkge1xuICAgICAgICAgICAgICAgIHZhciBsaW5lTnVtYmVyID0gbG9jYXRpb25QYXJ0cy5wb3AoKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gW2xvY2F0aW9uUGFydHMuam9pbignOicpLCBsaW5lTnVtYmVyLCBsYXN0TnVtYmVyXTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFtsb2NhdGlvblBhcnRzLmpvaW4oJzonKSwgbGFzdE51bWJlciwgdW5kZWZpbmVkXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuICAgICAgICBwYXJzZVY4T3JJRTogZnVuY3Rpb24gRXJyb3JTdGFja1BhcnNlciQkcGFyc2VWOE9ySUUoZXJyb3IpIHtcbiAgICAgICAgICAgIHJldHVybiBlcnJvci5zdGFjay5zcGxpdCgnXFxuJykuc2xpY2UoMSkubWFwKGZ1bmN0aW9uIChsaW5lKSB7XG4gICAgICAgICAgICAgICAgdmFyIHRva2VucyA9IGxpbmUucmVwbGFjZSgvXlxccysvLCAnJykuc3BsaXQoL1xccysvKS5zbGljZSgxKTtcbiAgICAgICAgICAgICAgICB2YXIgbG9jYXRpb25QYXJ0cyA9IHRoaXMuZXh0cmFjdExvY2F0aW9uKHRva2Vucy5wb3AoKS5yZXBsYWNlKC9bXFwoXFwpXFxzXS9nLCAnJykpO1xuICAgICAgICAgICAgICAgIHZhciBmdW5jdGlvbk5hbWUgPSAoIXRva2Vuc1swXSB8fCB0b2tlbnNbMF0gPT09ICdBbm9ueW1vdXMnKSA/IHVuZGVmaW5lZCA6IHRva2Vuc1swXTtcbiAgICAgICAgICAgICAgICByZXR1cm4gbmV3IFN0YWNrRnJhbWUoZnVuY3Rpb25OYW1lLCB1bmRlZmluZWQsIGxvY2F0aW9uUGFydHNbMF0sIGxvY2F0aW9uUGFydHNbMV0sIGxvY2F0aW9uUGFydHNbMl0pO1xuICAgICAgICAgICAgfSwgdGhpcyk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgcGFyc2VGRk9yU2FmYXJpOiBmdW5jdGlvbiBFcnJvclN0YWNrUGFyc2VyJCRwYXJzZUZGT3JTYWZhcmkoZXJyb3IpIHtcbiAgICAgICAgICAgIHJldHVybiBlcnJvci5zdGFjay5zcGxpdCgnXFxuJykuZmlsdGVyKGZ1bmN0aW9uIChsaW5lKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuICEhbGluZS5tYXRjaChGSVJFRk9YX1NBRkFSSV9TVEFDS19SRUdFWFApO1xuICAgICAgICAgICAgfSwgdGhpcykubWFwKGZ1bmN0aW9uIChsaW5lKSB7XG4gICAgICAgICAgICAgICAgdmFyIHRva2VucyA9IGxpbmUuc3BsaXQoJ0AnKTtcbiAgICAgICAgICAgICAgICB2YXIgbG9jYXRpb25QYXJ0cyA9IHRoaXMuZXh0cmFjdExvY2F0aW9uKHRva2Vucy5wb3AoKSk7XG4gICAgICAgICAgICAgICAgdmFyIGZ1bmN0aW9uTmFtZSA9IHRva2Vucy5zaGlmdCgpIHx8IHVuZGVmaW5lZDtcbiAgICAgICAgICAgICAgICByZXR1cm4gbmV3IFN0YWNrRnJhbWUoZnVuY3Rpb25OYW1lLCB1bmRlZmluZWQsIGxvY2F0aW9uUGFydHNbMF0sIGxvY2F0aW9uUGFydHNbMV0sIGxvY2F0aW9uUGFydHNbMl0pO1xuICAgICAgICAgICAgfSwgdGhpcyk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgcGFyc2VPcGVyYTogZnVuY3Rpb24gRXJyb3JTdGFja1BhcnNlciQkcGFyc2VPcGVyYShlKSB7XG4gICAgICAgICAgICBpZiAoIWUuc3RhY2t0cmFjZSB8fCAoZS5tZXNzYWdlLmluZGV4T2YoJ1xcbicpID4gLTEgJiZcbiAgICAgICAgICAgICAgICBlLm1lc3NhZ2Uuc3BsaXQoJ1xcbicpLmxlbmd0aCA+IGUuc3RhY2t0cmFjZS5zcGxpdCgnXFxuJykubGVuZ3RoKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLnBhcnNlT3BlcmE5KGUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmICghZS5zdGFjaykge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLnBhcnNlT3BlcmExMChlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMucGFyc2VPcGVyYTExKGUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LFxuXG4gICAgICAgIHBhcnNlT3BlcmE5OiBmdW5jdGlvbiBFcnJvclN0YWNrUGFyc2VyJCRwYXJzZU9wZXJhOShlKSB7XG4gICAgICAgICAgICB2YXIgbGluZVJFID0gL0xpbmUgKFxcZCspLipzY3JpcHQgKD86aW4gKT8oXFxTKykvaTtcbiAgICAgICAgICAgIHZhciBsaW5lcyA9IGUubWVzc2FnZS5zcGxpdCgnXFxuJyk7XG4gICAgICAgICAgICB2YXIgcmVzdWx0ID0gW107XG5cbiAgICAgICAgICAgIGZvciAodmFyIGkgPSAyLCBsZW4gPSBsaW5lcy5sZW5ndGg7IGkgPCBsZW47IGkgKz0gMikge1xuICAgICAgICAgICAgICAgIHZhciBtYXRjaCA9IGxpbmVSRS5leGVjKGxpbmVzW2ldKTtcbiAgICAgICAgICAgICAgICBpZiAobWF0Y2gpIHtcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0LnB1c2gobmV3IFN0YWNrRnJhbWUodW5kZWZpbmVkLCB1bmRlZmluZWQsIG1hdGNoWzJdLCBtYXRjaFsxXSkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSxcblxuICAgICAgICBwYXJzZU9wZXJhMTA6IGZ1bmN0aW9uIEVycm9yU3RhY2tQYXJzZXIkJHBhcnNlT3BlcmExMChlKSB7XG4gICAgICAgICAgICB2YXIgbGluZVJFID0gL0xpbmUgKFxcZCspLipzY3JpcHQgKD86aW4gKT8oXFxTKykoPzo6IEluIGZ1bmN0aW9uIChcXFMrKSk/JC9pO1xuICAgICAgICAgICAgdmFyIGxpbmVzID0gZS5zdGFja3RyYWNlLnNwbGl0KCdcXG4nKTtcbiAgICAgICAgICAgIHZhciByZXN1bHQgPSBbXTtcblxuICAgICAgICAgICAgZm9yICh2YXIgaSA9IDAsIGxlbiA9IGxpbmVzLmxlbmd0aDsgaSA8IGxlbjsgaSArPSAyKSB7XG4gICAgICAgICAgICAgICAgdmFyIG1hdGNoID0gbGluZVJFLmV4ZWMobGluZXNbaV0pO1xuICAgICAgICAgICAgICAgIGlmIChtYXRjaCkge1xuICAgICAgICAgICAgICAgICAgICByZXN1bHQucHVzaChuZXcgU3RhY2tGcmFtZShtYXRjaFszXSB8fCB1bmRlZmluZWQsIHVuZGVmaW5lZCwgbWF0Y2hbMl0sIG1hdGNoWzFdKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICB9LFxuXG4gICAgICAgIC8vIE9wZXJhIDEwLjY1KyBFcnJvci5zdGFjayB2ZXJ5IHNpbWlsYXIgdG8gRkYvU2FmYXJpXG4gICAgICAgIHBhcnNlT3BlcmExMTogZnVuY3Rpb24gRXJyb3JTdGFja1BhcnNlciQkcGFyc2VPcGVyYTExKGVycm9yKSB7XG4gICAgICAgICAgICByZXR1cm4gZXJyb3Iuc3RhY2suc3BsaXQoJ1xcbicpLmZpbHRlcihmdW5jdGlvbiAobGluZSkge1xuICAgICAgICAgICAgICAgIHJldHVybiAhIWxpbmUubWF0Y2goRklSRUZPWF9TQUZBUklfU1RBQ0tfUkVHRVhQKSAmJlxuICAgICAgICAgICAgICAgICAgICAhbGluZS5tYXRjaCgvXkVycm9yIGNyZWF0ZWQgYXQvKTtcbiAgICAgICAgICAgIH0sIHRoaXMpLm1hcChmdW5jdGlvbiAobGluZSkge1xuICAgICAgICAgICAgICAgIHZhciB0b2tlbnMgPSBsaW5lLnNwbGl0KCdAJyk7XG4gICAgICAgICAgICAgICAgdmFyIGxvY2F0aW9uUGFydHMgPSB0aGlzLmV4dHJhY3RMb2NhdGlvbih0b2tlbnMucG9wKCkpO1xuICAgICAgICAgICAgICAgIHZhciBmdW5jdGlvbkNhbGwgPSAodG9rZW5zLnNoaWZ0KCkgfHwgJycpO1xuICAgICAgICAgICAgICAgIHZhciBmdW5jdGlvbk5hbWUgPSBmdW5jdGlvbkNhbGxcbiAgICAgICAgICAgICAgICAgICAgICAgIC5yZXBsYWNlKC88YW5vbnltb3VzIGZ1bmN0aW9uKDogKFxcdyspKT8+LywgJyQyJylcbiAgICAgICAgICAgICAgICAgICAgICAgIC5yZXBsYWNlKC9cXChbXlxcKV0qXFwpL2csICcnKSB8fCB1bmRlZmluZWQ7XG4gICAgICAgICAgICAgICAgdmFyIGFyZ3NSYXc7XG4gICAgICAgICAgICAgICAgaWYgKGZ1bmN0aW9uQ2FsbC5tYXRjaCgvXFwoKFteXFwpXSopXFwpLykpIHtcbiAgICAgICAgICAgICAgICAgICAgYXJnc1JhdyA9IGZ1bmN0aW9uQ2FsbC5yZXBsYWNlKC9eW15cXChdK1xcKChbXlxcKV0qKVxcKSQvLCAnJDEnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgdmFyIGFyZ3MgPSAoYXJnc1JhdyA9PT0gdW5kZWZpbmVkIHx8IGFyZ3NSYXcgPT09ICdbYXJndW1lbnRzIG5vdCBhdmFpbGFibGVdJykgPyB1bmRlZmluZWQgOiBhcmdzUmF3LnNwbGl0KCcsJyk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBTdGFja0ZyYW1lKGZ1bmN0aW9uTmFtZSwgYXJncywgbG9jYXRpb25QYXJ0c1swXSwgbG9jYXRpb25QYXJ0c1sxXSwgbG9jYXRpb25QYXJ0c1syXSk7XG4gICAgICAgICAgICB9LCB0aGlzKTtcbiAgICAgICAgfVxuICAgIH07XG59KSk7XG5cbiIsIihmdW5jdGlvbiAocm9vdCwgZmFjdG9yeSkge1xuICAgICd1c2Ugc3RyaWN0JztcbiAgICAvLyBVbml2ZXJzYWwgTW9kdWxlIERlZmluaXRpb24gKFVNRCkgdG8gc3VwcG9ydCBBTUQsIENvbW1vbkpTL05vZGUuanMsIFJoaW5vLCBhbmQgYnJvd3NlcnMuXG4gICAgaWYgKHR5cGVvZiBkZWZpbmUgPT09ICdmdW5jdGlvbicgJiYgZGVmaW5lLmFtZCkge1xuICAgICAgICBkZWZpbmUoW10sIGZhY3RvcnkpO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIGV4cG9ydHMgPT09ICdvYmplY3QnKSB7XG4gICAgICAgIG1vZHVsZS5leHBvcnRzID0gZmFjdG9yeSgpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHJvb3QuU3RhY2tGcmFtZSA9IGZhY3RvcnkoKTtcbiAgICB9XG59KHRoaXMsIGZ1bmN0aW9uICgpIHtcbiAgICAndXNlIHN0cmljdCc7XG4gICAgZnVuY3Rpb24gX2lzTnVtYmVyKG4pIHtcbiAgICAgICAgcmV0dXJuICFpc05hTihwYXJzZUZsb2F0KG4pKSAmJiBpc0Zpbml0ZShuKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBTdGFja0ZyYW1lKGZ1bmN0aW9uTmFtZSwgYXJncywgZmlsZU5hbWUsIGxpbmVOdW1iZXIsIGNvbHVtbk51bWJlcikge1xuICAgICAgICBpZiAoZnVuY3Rpb25OYW1lICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgIHRoaXMuc2V0RnVuY3Rpb25OYW1lKGZ1bmN0aW9uTmFtZSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGFyZ3MgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgdGhpcy5zZXRBcmdzKGFyZ3MpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChmaWxlTmFtZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICB0aGlzLnNldEZpbGVOYW1lKGZpbGVOYW1lKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAobGluZU51bWJlciAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICB0aGlzLnNldExpbmVOdW1iZXIobGluZU51bWJlcik7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGNvbHVtbk51bWJlciAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICB0aGlzLnNldENvbHVtbk51bWJlcihjb2x1bW5OdW1iZXIpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgU3RhY2tGcmFtZS5wcm90b3R5cGUgPSB7XG4gICAgICAgIGdldEZ1bmN0aW9uTmFtZTogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuZnVuY3Rpb25OYW1lO1xuICAgICAgICB9LFxuICAgICAgICBzZXRGdW5jdGlvbk5hbWU6IGZ1bmN0aW9uICh2KSB7XG4gICAgICAgICAgICB0aGlzLmZ1bmN0aW9uTmFtZSA9IFN0cmluZyh2KTtcbiAgICAgICAgfSxcblxuICAgICAgICBnZXRBcmdzOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5hcmdzO1xuICAgICAgICB9LFxuICAgICAgICBzZXRBcmdzOiBmdW5jdGlvbiAodikge1xuICAgICAgICAgICAgaWYgKE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbCh2KSAhPT0gJ1tvYmplY3QgQXJyYXldJykge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ0FyZ3MgbXVzdCBiZSBhbiBBcnJheScpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhpcy5hcmdzID0gdjtcbiAgICAgICAgfSxcblxuICAgICAgICAvLyBOT1RFOiBQcm9wZXJ0eSBuYW1lIG1heSBiZSBtaXNsZWFkaW5nIGFzIGl0IGluY2x1ZGVzIHRoZSBwYXRoLFxuICAgICAgICAvLyBidXQgaXQgc29tZXdoYXQgbWlycm9ycyBWOCdzIEphdmFTY3JpcHRTdGFja1RyYWNlQXBpXG4gICAgICAgIC8vIGh0dHBzOi8vY29kZS5nb29nbGUuY29tL3Avdjgvd2lraS9KYXZhU2NyaXB0U3RhY2tUcmFjZUFwaVxuICAgICAgICBnZXRGaWxlTmFtZTogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuZmlsZU5hbWU7XG4gICAgICAgIH0sXG4gICAgICAgIHNldEZpbGVOYW1lOiBmdW5jdGlvbiAodikge1xuICAgICAgICAgICAgdGhpcy5maWxlTmFtZSA9IFN0cmluZyh2KTtcbiAgICAgICAgfSxcblxuICAgICAgICBnZXRMaW5lTnVtYmVyOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5saW5lTnVtYmVyO1xuICAgICAgICB9LFxuICAgICAgICBzZXRMaW5lTnVtYmVyOiBmdW5jdGlvbiAodikge1xuICAgICAgICAgICAgaWYgKCFfaXNOdW1iZXIodikpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdMaW5lIE51bWJlciBtdXN0IGJlIGEgTnVtYmVyJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB0aGlzLmxpbmVOdW1iZXIgPSBOdW1iZXIodik7XG4gICAgICAgIH0sXG5cbiAgICAgICAgZ2V0Q29sdW1uTnVtYmVyOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5jb2x1bW5OdW1iZXI7XG4gICAgICAgIH0sXG4gICAgICAgIHNldENvbHVtbk51bWJlcjogZnVuY3Rpb24gKHYpIHtcbiAgICAgICAgICAgIGlmICghX2lzTnVtYmVyKHYpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignQ29sdW1uIE51bWJlciBtdXN0IGJlIGEgTnVtYmVyJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB0aGlzLmNvbHVtbk51bWJlciA9IE51bWJlcih2KTtcbiAgICAgICAgfSxcblxuICAgICAgICB0b1N0cmluZzogZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICB2YXIgZnVuY3Rpb25OYW1lID0gdGhpcy5nZXRGdW5jdGlvbk5hbWUoKSB8fCAne2Fub255bW91c30nO1xuICAgICAgICAgICAgdmFyIGFyZ3MgPSAnKCcgKyAodGhpcy5nZXRBcmdzKCkgfHwgW10pLmpvaW4oJywnKSArICcpJztcbiAgICAgICAgICAgIHZhciBmaWxlTmFtZSA9IHRoaXMuZ2V0RmlsZU5hbWUoKSA/ICgnQCcgKyB0aGlzLmdldEZpbGVOYW1lKCkpIDogJyc7XG4gICAgICAgICAgICB2YXIgbGluZU51bWJlciA9IF9pc051bWJlcih0aGlzLmdldExpbmVOdW1iZXIoKSkgPyAoJzonICsgdGhpcy5nZXRMaW5lTnVtYmVyKCkpIDogJyc7XG4gICAgICAgICAgICB2YXIgY29sdW1uTnVtYmVyID0gX2lzTnVtYmVyKHRoaXMuZ2V0Q29sdW1uTnVtYmVyKCkpID8gKCc6JyArIHRoaXMuZ2V0Q29sdW1uTnVtYmVyKCkpIDogJyc7XG4gICAgICAgICAgICByZXR1cm4gZnVuY3Rpb25OYW1lICsgYXJncyArIGZpbGVOYW1lICsgbGluZU51bWJlciArIGNvbHVtbk51bWJlcjtcbiAgICAgICAgfVxuICAgIH07XG5cbiAgICByZXR1cm4gU3RhY2tGcmFtZTtcbn0pKTtcbiJdfQ==
