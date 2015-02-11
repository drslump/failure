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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJsaWIvY2FsbC1zaXRlLmpzIiwibGliL2ZhaWx1cmUuanMiLCJtYWluLmpzIiwibm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL3Byb2Nlc3MvYnJvd3Nlci5qcyIsIm5vZGVfbW9kdWxlcy9lcnJvci1zdGFjay1wYXJzZXIvZXJyb3Itc3RhY2stcGFyc2VyLmpzIiwibm9kZV9tb2R1bGVzL2Vycm9yLXN0YWNrLXBhcnNlci9ub2RlX21vZHVsZXMvc3RhY2tmcmFtZS9zdGFja2ZyYW1lLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO0FDQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FDN0RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7OztBQzVhQTtBQUNBO0FBQ0E7QUFDQTs7QUNIQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdEZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDeExBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EiLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbiBlKHQsbixyKXtmdW5jdGlvbiBzKG8sdSl7aWYoIW5bb10pe2lmKCF0W29dKXt2YXIgYT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2lmKCF1JiZhKXJldHVybiBhKG8sITApO2lmKGkpcmV0dXJuIGkobywhMCk7dmFyIGY9bmV3IEVycm9yKFwiQ2Fubm90IGZpbmQgbW9kdWxlICdcIitvK1wiJ1wiKTt0aHJvdyBmLmNvZGU9XCJNT0RVTEVfTk9UX0ZPVU5EXCIsZn12YXIgbD1uW29dPXtleHBvcnRzOnt9fTt0W29dWzBdLmNhbGwobC5leHBvcnRzLGZ1bmN0aW9uKGUpe3ZhciBuPXRbb11bMV1bZV07cmV0dXJuIHMobj9uOmUpfSxsLGwuZXhwb3J0cyxlLHQsbixyKX1yZXR1cm4gbltvXS5leHBvcnRzfXZhciBpPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7Zm9yKHZhciBvPTA7bzxyLmxlbmd0aDtvKyspcyhyW29dKTtyZXR1cm4gc30pIiwiLy8gRW11bGF0ZXMgVjgncyBDYWxsU2l0ZSBvYmplY3QgZnJvbSBhIHN0YWNrdHJhY2UuanMgZnJhbWUgb2JqZWN0XG5cbmZ1bmN0aW9uIENhbGxTaXRlIChmcmFtZSkge1xuICBpZiAoISh0aGlzIGluc3RhbmNlb2YgQ2FsbFNpdGUpKSB7XG4gICAgcmV0dXJuIG5ldyBDYWxsU2l0ZShmcmFtZSk7XG4gIH1cbiAgdGhpcy5mcmFtZSA9IGZyYW1lO1xufTtcblxuQ2FsbFNpdGUucHJvdG90eXBlID0gT2JqZWN0LmNyZWF0ZSh7XG4gIGdldExpbmVOdW1iZXI6IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gdGhpcy5mcmFtZS5saW5lTnVtYmVyO1xuICB9LFxuICBnZXRDb2x1bW5OdW1iZXI6IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gdGhpcy5mcmFtZS5jb2x1bW5OdW1iZXI7XG4gIH0sXG4gIGdldEZpbGVOYW1lOiBmdW5jdGlvbiAoKSB7XG4gICAgcmV0dXJuIHRoaXMuZnJhbWUuZmlsZU5hbWU7XG4gIH0sXG4gIGdldEZ1bmN0aW9uOiBmdW5jdGlvbiAoKSB7XG4gICAgcmV0dXJuIHRoaXMuZnJhbWUuZnVuY3Rpb247XG4gIH0sXG4gIGdldFRoaXM6IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfSxcbiAgZ2V0VHlwZU5hbWU6IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfSxcbiAgZ2V0TWV0aG9kTmFtZTogZnVuY3Rpb24gKCkge1xuICAgIGlmICh0aGlzLmZyYW1lLmZ1bmN0aW9uTmFtZSkge1xuICAgICAgcmV0dXJuIHRoaXMuZnJhbWUuZnVuY3Rpb25OYW1lLnNwbGl0KCcuJykucG9wKCk7XG4gICAgfVxuICAgIHJldHVybiBudWxsO1xuICB9LFxuICBnZXRGdW5jdGlvbk5hbWU6IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gdGhpcy5mcmFtZS5mdW5jdGlvbk5hbWU7XG4gIH0sXG4gIGdldEV2YWxPcmlnaW46IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfSxcbiAgaXNUb3BsZXZlbDogZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiBmYWxzZTsgLy8gVE9ET1xuICB9LFxuICBpc0V2YWw6IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gZmFsc2U7IC8vIFRPRE9cbiAgfSxcbiAgaXNOYXRpdmU6IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gZmFsc2U7IC8vIFRPRE9cbiAgfSxcbiAgaXNDb25zdHJ1Y3RvcjogZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiAvXm5ldyhcXHN8JCkvLnRlc3QodGhpcy5mcmFtZS5mdW5jdGlvbk5hbWUpO1xuICB9LFxuICB0b1N0cmluZzogZnVuY3Rpb24gKCkge1xuICAgIHZhciBuYW1lID0gdGhpcy5nZXRGdW5jdGlvbk5hbWUoKSB8fCAnPGFub255bW91cz4nO1xuICAgIHZhciBsb2MgPSB0aGlzLmdldEZpbGVOYW1lKCkgKyAnOicgKyB0aGlzLmdldExpbmVOdW1iZXIoKSArICc6JyArIHRoaXMuZ2V0Q29sdW1uTnVtYmVyKClcbiAgICByZXR1cm4gbmFtZSArICcgKCcgKyBsb2MgKyAnKSc7XG4gIH1cbn0pO1xuXG5cbm1vZHVsZS5leHBvcnRzID0gQ2FsbFNpdGU7XG4iLCJ2YXIgRXJyb3JTdGFja1BhcnNlciA9IHJlcXVpcmUoJ2Vycm9yLXN0YWNrLXBhcnNlcicpO1xudmFyIENhbGxTaXRlID0gcmVxdWlyZSgnLi9jYWxsLXNpdGUnKTtcblxuLy8gS2VlcCBhIHJlZmVyZW5jZSB0byB0aGUgYnVpbHRpbiBlcnJvciBjb25zdHJ1Y3RvclxudmFyIE5hdGl2ZUVycm9yID0gRXJyb3I7XG5cblxuZnVuY3Rpb24gRmFpbHVyZSAobWVzc2FnZSwgc2ZmKSB7XG4gIGlmICghKHRoaXMgaW5zdGFuY2VvZiBGYWlsdXJlKSkge1xuICAgIHJldHVybiBuZXcgRmFpbHVyZShtZXNzYWdlLCBzZmYgfHwgRmFpbHVyZSk7XG4gIH1cblxuICB0aGlzLnNmZiA9IHNmZiB8fCB0aGlzLmNvbnN0cnVjdG9yO1xuXG4gIHRoaXMubWVzc2FnZSA9IG1lc3NhZ2U7XG5cbiAgLy8gR2VuZXJhdGUgYSBnZXR0ZXIgZm9yIHRoZSBmcmFtZXMsIHRoaXMgZW5zdXJlcyB0aGF0IHdlIGRvIGFzIGxpdHRsZSB3b3JrXG4gIC8vIGFzIHBvc3NpYmxlIHdoZW4gaW5zdGFudGlhdGluZyB0aGUgZXJyb3IsIGRlZmVycmluZyB0aGUgZXhwZW5zaXZlIHN0YWNrXG4gIC8vIG1hbmdsaW5nIG9wZXJhdGlvbnMgdW50aWwgdGhlIC5zdGFjayBwcm9wZXJ0eSBpcyBhY3R1YWxseSByZXF1ZXN0ZWQuXG4gIHRoaXMuX2dldEZyYW1lcyA9IG1ha2VGcmFtZXNHZXR0ZXIodGhpcy5zZmYpO1xuXG4gIC8vIE9uIEVTNSBlbmdpbmVzIHdlIHVzZSBvbmUtdGltZSBnZXR0ZXJzIHRvIGFjdHVhbGx5IGRlZmVyIHRoZSBleHBlbnNpdmVcbiAgLy8gb3BlcmF0aW9ucyAoZGVmaW5lZCBpbiB0aGUgcHJvdG90eXBlIGZvciBwZXJmb3JtYW5jZSByZWFzb25zKSB3aGlsZSBsZWdhY3lcbiAgLy8gZW5naW5lcyB3aWxsIHNpbXBseSBkbyBhbGwgdGhlIHdvcmsgdXAgZnJvbnQuXG4gIGlmICh0eXBlb2YgT2JqZWN0LmRlZmluZVByb3BlcnR5ICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgdGhpcy5mcmFtZXMgPSB1bndpbmQodGhpcy5fZ2V0RnJhbWVzKCkpO1xuICAgIHRoaXMuX2dldEZyYW1lcyh0cnVlKTtcbiAgICB0aGlzLl9nZXRGcmFtZXMgPSBudWxsO1xuICAgIHRoaXMuc3RhY2sgPSB0aGlzLmdlbmVyYXRlU3RhY2tUcmFjZSgpO1xuICB9XG5cbiAgcmV0dXJuIHRoaXM7XG59XG5cbi8vIFNldCBGUkFNRV9FTVBUWSB0byBudWxsIHRvIGRpc2FibGUgYW55IHNvcnQgb2Ygc2VwYXJhdG9yXG5GYWlsdXJlLkZSQU1FX0VNUFRZID0gJyAgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSc7XG5GYWlsdXJlLkZSQU1FX1BSRUZJWCA9ICcgIGF0ICc7XG5cbi8vIEJ5IGRlZmF1bHQgd2UgZW5hYmxlIHRyYWNraW5nIGZvciBhc3luYyBzdGFjayB0cmFjZXNcbkZhaWx1cmUuVFJBQ0sgPSB0cnVlO1xuXG5cbi8vIEhlbHBlciB0byBvYnRhaW4gdGhlIGN1cnJlbnQgc3RhY2sgdHJhY2VcbnZhciBnZXRFcnJvcldpdGhTdGFjayA9IGZ1bmN0aW9uICgpIHtcbiAgcmV0dXJuIG5ldyBOYXRpdmVFcnJvcjtcbn07XG4vLyBTb21lIGVuZ2luZXMgZG8gbm90IGdlbmVyYXRlIHRoZSAuc3RhY2sgcHJvcGVydHkgdW50aWwgaXQncyB0aHJvd25cbmlmICghZ2V0RXJyb3JXaXRoU3RhY2soKS5zdGFjaykge1xuICBnZXRFcnJvcldpdGhTdGFjayA9IGZ1bmN0aW9uICgpIHtcbiAgICB0cnkgeyB0aHJvdyBuZXcgTmF0aXZlRXJyb3IgfSBjYXRjaCAoZSkgeyByZXR1cm4gZSB9O1xuICB9O1xufVxuXG4vLyBUcmltIGZyYW1lcyB1bmRlciB0aGUgcHJvdmlkZWQgc3RhY2sgZmlyc3QgZnVuY3Rpb25cbmZ1bmN0aW9uIHRyaW0oZnJhbWVzLCBzZmYpIHtcbiAgdmFyIGZuLCBuYW1lID0gc2ZmLm5hbWU7XG4gIGZvciAodmFyIGk9MDsgaSA8IGZyYW1lcy5sZW5ndGg7IGkrKykge1xuICAgIGZuID0gZnJhbWVzW2ldLmdldEZ1bmN0aW9uKCk7XG4gICAgaWYgKGZuICYmIGZuID09PSBzZmYgfHwgbmFtZSAmJiBuYW1lID09PSBmcmFtZXNbaV0uZ2V0RnVuY3Rpb25OYW1lKCkpIHtcbiAgICAgIHJldHVybiBmcmFtZXMuc2xpY2UoaSArIDEpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gZnJhbWVzO1xufVxuXG5mdW5jdGlvbiB1bndpbmQgKGZyYW1lcykge1xuICB2YXIgcmVzdWx0ID0gW107XG5cbiAgZm9yICh2YXIgaT0wLCBmbjsgaSA8IGZyYW1lcy5sZW5ndGg7IGkrKykge1xuICAgIGZuID0gZnJhbWVzW2ldLmdldEZ1bmN0aW9uKCk7XG5cbiAgICBpZiAoIWZuIHx8ICFmblsnZmFpbHVyZTppZ25vcmUnXSkge1xuICAgICAgcmVzdWx0LnB1c2goZnJhbWVzW2ldKTtcbiAgICB9XG5cbiAgICBpZiAoZm4gJiYgZm5bJ2ZhaWx1cmU6ZnJhbWVzJ10pIHtcbiAgICAgIGlmIChGYWlsdXJlLkZSQU1FX0VNUFRZKSB7XG4gICAgICAgIHJlc3VsdC5wdXNoKG51bGwpO1xuICAgICAgfVxuXG4gICAgICAvLyBDYWxsIHRoZSBnZXR0ZXIgYW5kIGtlZXAgYSByZWZlcmVuY2UgdG8gdGhlIHJlc3VsdCBpbiBjYXNlIHdlIGhhdmUgdG9cbiAgICAgIC8vIHVud2luZCB0aGUgc2FtZSBmdW5jdGlvbiBhbm90aGVyIHRpbWUuXG4gICAgICAvLyBUT0RPOiBNYWtlIHN1cmUga2VlcGluZyBhIHJlZmVyZW5jZSB0byB0aGUgZnJhbWVzIGRvZXNuJ3QgY3JlYXRlIGxlYWtzXG4gICAgICBpZiAodHlwZW9mIGZuWydmYWlsdXJlOmZyYW1lcyddID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIHZhciBnZXR0ZXIgPSBmblsnZmFpbHVyZTpmcmFtZXMnXTtcbiAgICAgICAgZm5bJ2ZhaWx1cmU6ZnJhbWVzJ10gPSBudWxsO1xuICAgICAgICBmblsnZmFpbHVyZTpmcmFtZXMnXSA9IGdldHRlcigpO1xuICAgICAgfVxuXG4gICAgICByZXN1bHQucHVzaC5hcHBseShyZXN1bHQsIHVud2luZChmblsnZmFpbHVyZTpmcmFtZXMnXSkpO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHJlc3VsdDtcbn1cblxuLy8gUmVjZWl2ZXIgZm9yIHRoZSBmcmFtZXMgaW4gYSAuc3RhY2sgcHJvcGVydHkgZnJvbSBjYXB0dXJlU3RhY2tUcmFjZVxudmFyIFY4RlJBTUVTID0ge307XG5cbi8vIFY4IGNvZGUgcGF0aCBmb3IgZ2VuZXJhdGluZyBhIGZyYW1lcyBnZXR0ZXJcbmZ1bmN0aW9uIG1ha2VGcmFtZXNHZXR0ZXJWOCAoc2ZmKSB7XG4gIE5hdGl2ZUVycm9yLmNhcHR1cmVTdGFja1RyYWNlKFY4RlJBTUVTLCBzZmYgfHwgbWFrZUZyYW1lc0dldHRlclY4KTtcbiAgc2ZmID0gbnVsbDtcbiAgdmFyIGZyYW1lcyA9IFY4RlJBTUVTLnN0YWNrO1xuICBWOEZSQU1FUy5zdGFjayA9IG51bGw7ICAvLyBJTVBPUlRBTlQ6IFRoaXMgaXMgbmVlZGVkIHRvIGF2b2lkIGxlYWtzISEhXG4gIHJldHVybiBmdW5jdGlvbiAoY2xlYW51cCkge1xuICAgIHZhciByZXN1bHQgPSBmcmFtZXM7XG4gICAgLy8gQ2xlYW4gdXAgY2xvc3VyZSB2YXJpYWJsZXMgdG8gaGVscCBHQ1xuICAgIGZyYW1lcyA9IG51bGw7XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfTtcbn1cblxuLy8gbm9uLVY4IGNvZGUgcGF0aCBmb3IgZ2VuZXJhdGluZyBhIGZyYW1lcyBnZXR0ZXJcbmZ1bmN0aW9uIG1ha2VGcmFtZXNHZXR0ZXJDb21wYXQgKHNmZikge1xuICAvLyBPYnRhaW4gYSBzdGFjayB0cmFjZSBhdCB0aGUgY3VycmVudCBwb2ludFxuICB2YXIgZXJyb3IgPSBnZXRFcnJvcldpdGhTdGFjaygpO1xuXG4gIC8vIFdhbGsgdGhlIGNhbGxlciBjaGFpbiB0byBhbm5vdGF0ZSB0aGUgc3RhY2sgd2l0aCBmdW5jdGlvbiByZWZlcmVuY2VzXG4gIC8vIEdpdmVuIHRoZSBsaW1pdGF0aW9ucyBpbXBvc2VkIGJ5IEVTNSBcInN0cmljdCBtb2RlXCIgaXQncyBub3QgcG9zc2libGVcbiAgLy8gdG8gb2J0YWluIHJlZmVyZW5jZXMgdG8gZnVuY3Rpb25zIGJleW9uZCBvbmUgdGhhdCBpcyBkZWZpbmVkIGluIHN0cmljdFxuICAvLyBtb2RlLiBBbHNvIG5vdGUgdGhhdCBhbnkga2luZCBvZiByZWN1cnNpb24gd2lsbCBtYWtlIHRoZSB3YWxrZXIgdW5hYmxlXG4gIC8vIHRvIGdvIHBhc3QgaXQuXG4gIHZhciBjYWxsZXIgPSBhcmd1bWVudHMuY2FsbGVlO1xuICB2YXIgZnVuY3Rpb25zID0gW2dldEVycm9yV2l0aFN0YWNrXTtcbiAgZm9yICh2YXIgaT0wOyBjYWxsZXIgJiYgaSA8IDEwOyBpKyspIHtcbiAgICBmdW5jdGlvbnMucHVzaChjYWxsZXIpO1xuICAgIGlmIChjYWxsZXIuY2FsbGVyID09PSBjYWxsZXIpIGJyZWFrO1xuICAgIGNhbGxlciA9IGNhbGxlci5jYWxsZXI7XG4gIH1cbiAgY2FsbGVyID0gbnVsbDtcblxuICByZXR1cm4gZnVuY3Rpb24gKGNsZWFudXApIHtcbiAgICB2YXIgZnJhbWVzID0gbnVsbDtcblxuICAgIGlmICghY2xlYW51cCkge1xuICAgICAgLy8gUGFyc2UgdGhlIHN0YWNrIHRyYWNlXG4gICAgICBmcmFtZXMgPSBFcnJvclN0YWNrUGFyc2VyLnBhcnNlKGVycm9yKTtcbiAgICAgIC8vIEF0dGFjaCBmdW5jdGlvbiByZWZlcmVuY2VzIHRvIHRoZSBmcmFtZXMgKHNraXBwaW5nIHRoZSBtYWtlciBmcmFtZXMpXG4gICAgICAvLyBhbmQgY3JlYXRpbmcgQ2FsbFNpdGUgb2JqZWN0cyBmb3IgZWFjaCBvbmUuXG4gICAgICBmb3IgKHZhciBpPTI7IGkgPCBmcmFtZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgZnJhbWVzW2ldLmZ1bmN0aW9uID0gZnVuY3Rpb25zW2ldO1xuICAgICAgICBmcmFtZXNbaV0gPSBuZXcgQ2FsbFNpdGUoZnJhbWVzW2ldKTtcbiAgICAgIH1cblxuICAgICAgZnJhbWVzID0gdHJpbShmcmFtZXMuc2xpY2UoMiksIHNmZik7XG4gICAgfVxuXG4gICAgLy8gQ2xlYW4gdXAgY2xvc3VyZSB2YXJpYWJsZXMgdG8gaGVscCBHQ1xuICAgIHNmZiA9IG51bGw7XG4gICAgZXJyb3IgPSBudWxsO1xuICAgIGZ1bmN0aW9ucyA9IG51bGw7XG5cbiAgICByZXR1cm4gZnJhbWVzO1xuICB9O1xufVxuXG4vLyBHZW5lcmF0ZXMgYSBnZXR0ZXIgZm9yIHRoZSBjYWxsIHNpdGUgZnJhbWVzXG4vLyBUT0RPOiBJZiB3ZSBvYnNlcnZlIGxlYWtzIHdpdGggY29tcGxleCB1c2UgY2FzZXMgKGR1ZSB0byBjbG9zdXJlIHNjb3Blcylcbi8vICAgICAgIHdlIGNhbiBnZW5lcmF0ZSBoZXJlIG91ciBjb21wYXQgQ2FsbFNpdGUgb2JqZWN0cyBzdG9yaW5nIHRoZSBmdW5jdGlvbidzXG4vLyAgICAgICBzb3VyY2UgY29kZSBpbnN0ZWFkIG9mIGFuIGFjdHVhbCByZWZlcmVuY2UgdG8gdGhlbSwgdGhhdCBzaG91bGQgaGVscFxuLy8gICAgICAgdGhlIEdDIHNpbmNlIHdlJ2xsIGJlIGp1c3Qga2VlcGluZyBsaXRlcmFscyBhcm91bmQuXG52YXIgbWFrZUZyYW1lc0dldHRlciA9IHR5cGVvZiBOYXRpdmVFcnJvci5jYXB0dXJlU3RhY2tUcmFjZSA9PT0gJ2Z1bmN0aW9uJ1xuICAgICAgICAgICAgICAgICAgICAgPyBtYWtlRnJhbWVzR2V0dGVyVjhcbiAgICAgICAgICAgICAgICAgICAgIDogbWFrZUZyYW1lc0dldHRlckNvbXBhdDtcblxuXG4vLyBPdmVycmlkZSBWOCBzdGFjayB0cmFjZSBidWlsZGVyIHRvIGluamVjdCBvdXIgbG9naWNcbnZhciBvbGRQcmVwYXJlU3RhY2tUcmFjZSA9IEVycm9yLnByZXBhcmVTdGFja1RyYWNlO1xuRXJyb3IucHJlcGFyZVN0YWNrVHJhY2UgPSBmdW5jdGlvbiAoZXJyb3IsIGZyYW1lcykge1xuICAvLyBXaGVuIGNhbGxlZCBmcm9tIG1ha2VGcmFtZXNHZXR0ZXIgd2UganVzdCB3YW50IHRvIG9idGFpbiB0aGUgZnJhbWVzXG4gIGlmIChlcnJvciA9PT0gVjhGUkFNRVMpIHtcbiAgICByZXR1cm4gZnJhbWVzO1xuICB9XG5cbiAgLy8gRm9yd2FyZCB0byBhbnkgcHJldmlvdXNseSBkZWZpbmVkIGJlaGF2aW91clxuICBpZiAob2xkUHJlcGFyZVN0YWNrVHJhY2UpIHtcbiAgICByZXR1cm4gb2xkUHJlcGFyZVN0YWNrVHJhY2UuY2FsbChFcnJvciwgZXJyb3IsIGZyYW1lcyk7XG4gIH1cblxuICAvLyBFbXVsYXRlIGRlZmF1bHQgYmVoYXZpb3VyICh3aXRoIGxvbmctdHJhY2VzKVxuICByZXR1cm4gRmFpbHVyZS5wcm90b3R5cGUucHJlcGFyZVN0YWNrVHJhY2UuY2FsbChlcnJvciwgdW53aW5kKGZyYW1lcykpO1xufTtcblxuLy8gQXR0YWNoIGEgbmV3IGV4Y2x1c2lvbiBwcmVkaWNhdGUgZm9yIGZyYW1lc1xuZnVuY3Rpb24gZXhjbHVkZSAoY3RvciwgcHJlZGljYXRlKSB7XG4gIHZhciBmbiA9IHByZWRpY2F0ZTtcblxuICBpZiAodHlwZW9mIHByZWRpY2F0ZSA9PT0gJ3N0cmluZycpIHtcbiAgICBmbiA9IGZ1bmN0aW9uIChmcmFtZSkge1xuICAgICAgcmV0dXJuIC0xICE9PSBmcmFtZS5nZXRGaWxlTmFtZSgpLmluZGV4T2YocHJlZGljYXRlKTtcbiAgICB9O1xuICB9IGVsc2UgaWYgKHR5cGVvZiBwcmVkaWNhdGUudGVzdCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIGZuID0gZnVuY3Rpb24gKGZyYW1lKSB7XG4gICAgICByZXR1cm4gcHJlZGljYXRlLnRlc3QoZnJhbWUuZ2V0RmlsZU5hbWUoKSk7XG4gICAgfTtcbiAgfVxuXG4gIGN0b3IuZXhjbHVkZXMucHVzaChmbik7XG59XG5cbi8vIEV4cG9zZSB0aGUgZmlsdGVyIGluIHRoZSByb290IEZhaWx1cmUgdHlwZVxuRmFpbHVyZS5leGNsdWRlcyA9IFtdO1xuRmFpbHVyZS5leGNsdWRlID0gZnVuY3Rpb24gRmFpbHVyZV9leGNsdWRlIChwcmVkaWNhdGUpIHtcbiAgZXhjbHVkZShGYWlsdXJlLCBwcmVkaWNhdGUpO1xufTtcblxuLy8gQXR0YWNoIGEgZnJhbWVzIGdldHRlciB0byB0aGUgZnVuY3Rpb24gc28gd2UgY2FuIHJlLWNvbnN0cnVjdCBhc3luYyBzdGFja3MuXG4vL1xuLy8gTm90ZSB0aGF0IHRoaXMganVzdCBhdWdtZW50cyB0aGUgZnVuY3Rpb24gd2l0aCB0aGUgbmV3IHByb3BlcnR5LCBpdCBkb2Vzbid0XG4vLyBjcmVhdGUgYSB3cmFwcGVyIGV2ZXJ5IHRpbWUgaXQncyBjYWxsZWQsIHNvIHVzaW5nIGl0IG11bHRpcGxlIHRpbWVzIG9uIHRoZVxuLy8gc2FtZSBmdW5jdGlvbiB3aWxsIGluZGVlZCBvdmVyd3JpdGUgdGhlIHByZXZpb3VzIHRyYWNraW5nIGluZm9ybWF0aW9uLiBUaGlzXG4vLyBpcyBpbnRlbmRlZCBzaW5jZSBpdCdzIGZhc3RlciBhbmQgbW9yZSBpbXBvcnRhbnRseSBkb2Vzbid0IGJyZWFrIHNvbWUgQVBJc1xuLy8gdXNpbmcgY2FsbGJhY2sgcmVmZXJlbmNlcyB0byB1bnJlZ2lzdGVyIHRoZW0gZm9yIGluc3RhbmNlLlxuLy8gV2hlbiB5b3Ugd2FudCB0byB1c2UgdGhlIHNhbWUgZnVuY3Rpb24gd2l0aCBkaWZmZXJlbnQgdHJhY2tpbmcgaW5mb3JtYXRpb25cbi8vIGp1c3QgdXNlIEZhaWx1cmUud3JhcCgpLlxuLy9cbi8vIFRoZSB0cmFja2luZyBjYW4gYmUgZ2xvYmFsbHkgZGlzYWJsZWQgYnkgc2V0dGluZyBGYWlsdXJlLlRSQUNLIHRvIGZhbHNlXG5GYWlsdXJlLnRyYWNrID0gZnVuY3Rpb24gRmFpbHVyZV90cmFjayAoZm4sIHNmZikge1xuICBpZiAodHlwZW9mIGZuICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgcmV0dXJuIGZuO1xuICB9XG5cbiAgLy8gQ2xlYW4gdXAgcHJldmlvdXMgZnJhbWVzIHRvIGhlbHAgdGhlIEdDXG4gIGlmICh0eXBlb2YgZm5bJ2ZhaWx1cmU6ZnJhbWVzJ10gPT09ICdmdW5jdGlvbicpIHtcbiAgICBmblsnZmFpbHVyZTpmcmFtZXMnXSh0cnVlKTtcbiAgfVxuXG4gIGlmIChGYWlsdXJlLlRSQUNLKSB7XG4gICAgZm5bJ2ZhaWx1cmU6ZnJhbWVzJ10gPSBudWxsO1xuICAgIGZuWydmYWlsdXJlOmZyYW1lcyddID0gbWFrZUZyYW1lc0dldHRlcihzZmYgfHwgRmFpbHVyZV90cmFjayk7XG4gIH1cblxuICByZXR1cm4gZm47XG59O1xuXG4vLyBXcmFwcyB0aGUgZnVuY3Rpb24gYmVmb3JlIGFubm90YXRpbmcgaXQgd2l0aCB0cmFja2luZyBpbmZvcm1hdGlvbiwgdGhpc1xuLy8gYWxsb3dzIHRvIHRyYWNrIG11bHRpcGxlIHNjaGVkdWxsaW5ncyBvZiBhIHNpbmdsZSBmdW5jdGlvbi5cbkZhaWx1cmUud3JhcCA9IGZ1bmN0aW9uIEZhaWx1cmVfd3JhcCAoZm4pIHtcbiAgdmFyIHdyYXBwZXIgPSBGYWlsdXJlLmlnbm9yZShmdW5jdGlvbiAoKSB7XG4gICAgcmV0dXJuIGZuLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gIH0pO1xuXG4gIHJldHVybiBGYWlsdXJlLnRyYWNrKHdyYXBwZXIsIEZhaWx1cmVfd3JhcCk7XG59O1xuXG4vLyBNYXJrIGEgZnVuY3Rpb24gdG8gYmUgaWdub3JlZCB3aGVuIGdlbmVyYXRpbmcgc3RhY2sgdHJhY2VzXG5GYWlsdXJlLmlnbm9yZSA9IGZ1bmN0aW9uIEZhaWx1cmVfaWdub3JlIChmbikge1xuICBmblsnZmFpbHVyZTppZ25vcmUnXSA9IHRydWU7XG4gIHJldHVybiBmbjtcbn07XG5cbkZhaWx1cmUuc2V0VGltZW91dCA9IGZ1bmN0aW9uIEZhaWx1cmVfc2V0VGltZW91dCAoKSB7XG4gIGFyZ3VtZW50c1swXSA9IEZhaWx1cmUudHJhY2soYXJndW1lbnRzWzBdLCBGYWlsdXJlX3NldFRpbWVvdXQpO1xuICByZXR1cm4gc2V0VGltZW91dC5hcHBseShudWxsLCBhcmd1bWVudHMpO1xufTtcblxuRmFpbHVyZS5uZXh0VGljayA9IGZ1bmN0aW9uIEZhaWx1cmVfbmV4dFRpY2sgKCkge1xuICBhcmd1bWVudHNbMF0gPSBGYWlsdXJlLnRyYWNrKGFyZ3VtZW50c1swXSwgRmFpbHVyZV9uZXh0VGljayk7XG4gIHJldHVybiBwcm9jZXNzLm5leHRUaWNrLmFwcGx5KHByb2Nlc3MsIGFyZ3VtZW50cyk7XG59O1xuXG5GYWlsdXJlLnBhdGNoID0gZnVuY3Rpb24gRmFpbHVyZV9wYXRjaChvYmosIG5hbWUsIGlkeCkge1xuICBpZiAob2JqICYmIHR5cGVvZiBvYmpbbmFtZV0gIT09ICdmdW5jdGlvbicpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ09iamVjdCBkb2VzIG5vdCBoYXZlIGEgXCInICsgbmFtZSArICdcIiBtZXRob2QnKTtcbiAgfVxuXG4gIHZhciBvcmlnaW5hbCA9IG9ialtuYW1lXTtcblxuICAvLyBXaGVuIHRoZSBleGFjdCBhcmd1bWVudCBpbmRleCBpcyBwcm92aWRlZCB1c2UgYW4gb3B0aW1pemVkIGNvZGUgcGF0aFxuICBpZiAodHlwZW9mIGlkeCA9PT0gJ251bWJlcicpIHtcblxuICAgIG9ialtuYW1lXSA9IGZ1bmN0aW9uICgpIHtcbiAgICAgIGFyZ3VtZW50c1tpZHhdID0gRmFpbHVyZS50cmFjayhhcmd1bWVudHNbaWR4XSwgb2JqW25hbWVdKTtcbiAgICAgIHJldHVybiBvcmlnaW5hbC5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xuICAgIH07XG5cbiAgLy8gT3RoZXJ3aXNlIGRldGVjdCB0aGUgZnVuY3Rpb25zIHRvIHRyYWNrIGF0IGludm9rYXRpb24gdGltZVxuICB9IGVsc2Uge1xuXG4gICAgb2JqW25hbWVdID0gZnVuY3Rpb24gKCkge1xuICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBhcmd1bWVudHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgaWYgKHR5cGVvZiBhcmd1bWVudHNbaV0gPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICBhcmd1bWVudHNbaV0gPSBGYWlsdXJlLnRyYWNrKGFyZ3VtZW50c1tpXSwgb2JqW25hbWVdKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuIG9yaWdpbmFsLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gICAgfTtcblxuICB9XG5cbiAgLy8gQXVnbWVudCB0aGUgd3JhcHBlciB3aXRoIGFueSBwcm9wZXJ0aWVzIGZyb20gdGhlIG9yaWdpbmFsXG4gIGZvciAodmFyIGsgaW4gb3JpZ2luYWwpIGlmIChvcmlnaW5hbC5oYXNPd25Qcm9wZXJ0eShrKSkge1xuICAgIG9ialtuYW1lXVtrXSA9IG9yaWdpbmFsW2tdO1xuICB9XG5cbiAgcmV0dXJuIG9ialtuYW1lXTtcbn07XG5cbi8vIEhlbHBlciB0byBjcmVhdGUgbmV3IEZhaWx1cmUgdHlwZXNcbkZhaWx1cmUuY3JlYXRlID0gZnVuY3Rpb24gKG5hbWUsIHByb3BzKSB7XG4gIGlmICh0eXBlb2YgbmFtZSAhPT0gJ3N0cmluZycpIHtcbiAgICB0aHJvdyBuZXcgRmFpbHVyZSgnRXhwZWN0ZWQgYSBuYW1lIGFzIGZpcnN0IGFyZ3VtZW50Jyk7XG4gIH1cblxuICBmdW5jdGlvbiBjdG9yIChtZXNzYWdlLCBzZmYpIHtcbiAgICBpZiAoISh0aGlzIGluc3RhbmNlb2YgRmFpbHVyZSkpIHtcbiAgICAgIHJldHVybiBuZXcgY3RvcihtZXNzYWdlLCBzZmYpO1xuICAgIH1cbiAgICBGYWlsdXJlLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gIH1cblxuICAvLyBBdWdtZW50IGNvbnN0cnVjdG9yXG4gIGN0b3IuZXhjbHVkZXMgPSBbXTtcbiAgY3Rvci5leGNsdWRlID0gZnVuY3Rpb24gKHByZWRpY2F0ZSkge1xuICAgIGV4Y2x1ZGUoY3RvciwgcHJlZGljYXRlKTtcbiAgfTtcblxuICBjdG9yLnByb3RvdHlwZSA9IE9iamVjdC5jcmVhdGUoRmFpbHVyZS5wcm90b3R5cGUpO1xuICBjdG9yLnByb3RvdHlwZS5jb25zdHJ1Y3RvciA9IGN0b3I7XG4gIGN0b3IucHJvdG90eXBlLm5hbWUgPSBuYW1lO1xuICBpZiAodHlwZW9mIHByb3BzID09PSAnZnVuY3Rpb24nKSB7XG4gICAgY3Rvci5wcm90b3R5cGUucHJlcGFyZVN0YWNrVHJhY2UgPSBwcm9wcztcbiAgfSBlbHNlIGlmIChwcm9wcykge1xuICAgIE9iamVjdC5rZXlzKHByb3BzKS5mb3JFYWNoKGZ1bmN0aW9uIChwcm9wKSB7XG4gICAgICBjdG9yLnByb3RvdHlwZVtwcm9wXSA9IHByb3A7XG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIGN0b3I7XG59O1xuXG52YXIgYnVpbHRpbkVycm9yVHlwZXMgPSBbXG4gICdFcnJvcicsICdUeXBlRXJyb3InLCAnUmFuZ2VFcnJvcicsICdSZWZlcmVuY2VFcnJvcicsICdTeW50YXhFcnJvcicsXG4gICdFdmFsRXJyb3InLCAnVVJJRXJyb3InLCAnSW50ZXJuYWxFcnJvcidcbl07XG52YXIgYnVpbHRpbkVycm9ycyA9IHt9O1xuXG5GYWlsdXJlLmluc3RhbGwgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciByb290ID0gdHlwZW9mIHdpbmRvdyA9PT0gJ29iamVjdCcgPyB3aW5kb3cgOiBnbG9iYWw7XG5cbiAgYnVpbHRpbkVycm9yVHlwZXMuZm9yRWFjaChmdW5jdGlvbiAodHlwZSkge1xuICAgIGlmIChyb290W3R5cGVdICYmICFidWlsdGluRXJyb3JzW3R5cGVdKSB7XG4gICAgICBidWlsdGluRXJyb3JzW3R5cGVdID0gcm9vdFt0eXBlXTtcbiAgICAgIHJvb3RbdHlwZV0gPSBGYWlsdXJlLmNyZWF0ZSh0eXBlKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIEFsbG93IHVzYWdlOiB2YXIgRmFpbHVyZSA9IHJlcXVpcmUoJ2ZhaWx1cmUnKS5pbnN0YWxsKClcbiAgcmV0dXJuIEZhaWx1cmU7XG59O1xuXG5GYWlsdXJlLnVuaW5zdGFsbCA9IGZ1bmN0aW9uICgpIHtcbiAgYnVpbHRpbkVycm9yVHlwZXMuZm9yRWFjaChmdW5jdGlvbiAodHlwZSkge1xuICAgIHJvb3RbdHlwZV0gPSBidWlsdGluRXJyb3JzW3R5cGVdIHx8IHJvb3RbdHlwZV07XG4gIH0pO1xufTtcblxuXG52YXIgcHJvdG8gPSBGYWlsdXJlLnByb3RvdHlwZSA9IE9iamVjdC5jcmVhdGUoRXJyb3IucHJvdG90eXBlKTtcbnByb3RvLmNvbnN0cnVjdG9yID0gRmFpbHVyZTtcblxucHJvdG8ubmFtZSA9ICdGYWlsdXJlJztcbnByb3RvLm1lc3NhZ2UgPSAnJztcblxuaWYgKHR5cGVvZiBPYmplY3QuZGVmaW5lUHJvcGVydHkgPT09ICdmdW5jdGlvbicpIHtcbiAgT2JqZWN0LmRlZmluZVByb3BlcnR5KHByb3RvLCAnZnJhbWVzJywge1xuICAgIGdldDogZnVuY3Rpb24gKCkge1xuICAgICAgLy8gVXNlIHRyaW1taW5nIGp1c3QgaW4gY2FzZSB0aGUgc2ZmIHdhcyBkZWZpbmVkIGFmdGVyIGNvbnN0cnVjdGluZ1xuICAgICAgdmFyIGZyYW1lcyA9IHVud2luZCh0cmltKHRoaXMuX2dldEZyYW1lcygpLCB0aGlzLnNmZikpO1xuXG4gICAgICAvLyBDYWNoZSBuZXh0IGFjY2Vzc2VzIHRvIHRoZSBwcm9wZXJ0eVxuICAgICAgT2JqZWN0LmRlZmluZVByb3BlcnR5KHRoaXMsICdmcmFtZXMnLCB7XG4gICAgICAgIHZhbHVlOiBmcmFtZXMsXG4gICAgICAgIHdyaXRhYmxlOiB0cnVlXG4gICAgICB9KTtcblxuICAgICAgLy8gQ2xlYW4gdXAgdGhlIGdldHRlciBjbG9zdXJlXG4gICAgICB0aGlzLl9nZXRGcmFtZXMgPSBudWxsO1xuXG4gICAgICByZXR1cm4gZnJhbWVzO1xuICAgIH1cbiAgfSk7XG5cbiAgT2JqZWN0LmRlZmluZVByb3BlcnR5KHByb3RvLCAnc3RhY2snLCB7XG4gICAgZ2V0OiBmdW5jdGlvbiAoKSB7XG4gICAgICByZXR1cm4gdGhpcy5nZW5lcmF0ZVN0YWNrVHJhY2UoKTtcbiAgICB9XG4gIH0pO1xufVxuXG5wcm90by5nZW5lcmF0ZVN0YWNrVHJhY2UgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBleGNsdWRlcyA9IHRoaXMuY29uc3RydWN0b3IuZXhjbHVkZXM7XG4gIHZhciBpbmNsdWRlLCBmcmFtZXMgPSBbXTtcblxuICAvLyBTcGVjaWZpYyBwcm90b3R5cGVzIGluaGVyaXQgdGhlIGV4Y2x1ZGVzIGZyb20gRmFpbHVyZVxuICBpZiAoZXhjbHVkZXMgIT09IEZhaWx1cmUuZXhjbHVkZXMpIHtcbiAgICBleGNsdWRlcy5wdXNoLmFwcGx5KGV4Y2x1ZGVzLCBGYWlsdXJlLmV4Y2x1ZGVzKTtcbiAgfVxuXG4gIC8vIEFwcGx5IGZpbHRlcmluZ1xuICBmb3IgKHZhciBpPTA7IGkgPCB0aGlzLmZyYW1lcy5sZW5ndGg7IGkrKykge1xuICAgIGluY2x1ZGUgPSB0cnVlO1xuICAgIGlmICh0aGlzLmZyYW1lc1tpXSkge1xuICAgICAgZm9yICh2YXIgaj0wOyBpbmNsdWRlICYmIGogPCBleGNsdWRlcy5sZW5ndGg7IGorKykge1xuICAgICAgICBpbmNsdWRlICY9ICFleGNsdWRlc1tqXS5jYWxsKHRoaXMsIHRoaXMuZnJhbWVzW2ldKTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKGluY2x1ZGUpIHtcbiAgICAgIGZyYW1lcy5wdXNoKHRoaXMuZnJhbWVzW2ldKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gdGhpcy5wcmVwYXJlU3RhY2tUcmFjZShmcmFtZXMpO1xufTtcblxucHJvdG8ucHJlcGFyZVN0YWNrVHJhY2UgPSBmdW5jdGlvbiAoZnJhbWVzKSB7XG4gIHZhciBsaW5lcyA9IFt0aGlzXTtcbiAgZm9yICh2YXIgaT0wOyBpIDwgZnJhbWVzLmxlbmd0aDsgaSsrKSB7XG4gICAgbGluZXMucHVzaChcbiAgICAgIGZyYW1lc1tpXSA/IEZhaWx1cmUuRlJBTUVfUFJFRklYICsgZnJhbWVzW2ldIDogRmFpbHVyZS5GUkFNRV9FTVBUWVxuICAgICk7XG4gIH1cbiAgcmV0dXJuIGxpbmVzLmpvaW4oJ1xcbicpO1xufTtcblxuXG5tb2R1bGUuZXhwb3J0cyA9IEZhaWx1cmU7XG4iLCJ2YXIgRmFpbHVyZSA9IHJlcXVpcmUoJy4vbGliL2ZhaWx1cmUnKTtcblxubW9kdWxlLmV4cG9ydHMgPSBGYWlsdXJlO1xuIiwiLy8gc2hpbSBmb3IgdXNpbmcgcHJvY2VzcyBpbiBicm93c2VyXG5cbnZhciBwcm9jZXNzID0gbW9kdWxlLmV4cG9ydHMgPSB7fTtcblxucHJvY2Vzcy5uZXh0VGljayA9IChmdW5jdGlvbiAoKSB7XG4gICAgdmFyIGNhblNldEltbWVkaWF0ZSA9IHR5cGVvZiB3aW5kb3cgIT09ICd1bmRlZmluZWQnXG4gICAgJiYgd2luZG93LnNldEltbWVkaWF0ZTtcbiAgICB2YXIgY2FuTXV0YXRpb25PYnNlcnZlciA9IHR5cGVvZiB3aW5kb3cgIT09ICd1bmRlZmluZWQnXG4gICAgJiYgd2luZG93Lk11dGF0aW9uT2JzZXJ2ZXI7XG4gICAgdmFyIGNhblBvc3QgPSB0eXBlb2Ygd2luZG93ICE9PSAndW5kZWZpbmVkJ1xuICAgICYmIHdpbmRvdy5wb3N0TWVzc2FnZSAmJiB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lclxuICAgIDtcblxuICAgIGlmIChjYW5TZXRJbW1lZGlhdGUpIHtcbiAgICAgICAgcmV0dXJuIGZ1bmN0aW9uIChmKSB7IHJldHVybiB3aW5kb3cuc2V0SW1tZWRpYXRlKGYpIH07XG4gICAgfVxuXG4gICAgdmFyIHF1ZXVlID0gW107XG5cbiAgICBpZiAoY2FuTXV0YXRpb25PYnNlcnZlcikge1xuICAgICAgICB2YXIgaGlkZGVuRGl2ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgICAgdmFyIG9ic2VydmVyID0gbmV3IE11dGF0aW9uT2JzZXJ2ZXIoZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgdmFyIHF1ZXVlTGlzdCA9IHF1ZXVlLnNsaWNlKCk7XG4gICAgICAgICAgICBxdWV1ZS5sZW5ndGggPSAwO1xuICAgICAgICAgICAgcXVldWVMaXN0LmZvckVhY2goZnVuY3Rpb24gKGZuKSB7XG4gICAgICAgICAgICAgICAgZm4oKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcblxuICAgICAgICBvYnNlcnZlci5vYnNlcnZlKGhpZGRlbkRpdiwgeyBhdHRyaWJ1dGVzOiB0cnVlIH0pO1xuXG4gICAgICAgIHJldHVybiBmdW5jdGlvbiBuZXh0VGljayhmbikge1xuICAgICAgICAgICAgaWYgKCFxdWV1ZS5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICBoaWRkZW5EaXYuc2V0QXR0cmlidXRlKCd5ZXMnLCAnbm8nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHF1ZXVlLnB1c2goZm4pO1xuICAgICAgICB9O1xuICAgIH1cblxuICAgIGlmIChjYW5Qb3N0KSB7XG4gICAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdtZXNzYWdlJywgZnVuY3Rpb24gKGV2KSB7XG4gICAgICAgICAgICB2YXIgc291cmNlID0gZXYuc291cmNlO1xuICAgICAgICAgICAgaWYgKChzb3VyY2UgPT09IHdpbmRvdyB8fCBzb3VyY2UgPT09IG51bGwpICYmIGV2LmRhdGEgPT09ICdwcm9jZXNzLXRpY2snKSB7XG4gICAgICAgICAgICAgICAgZXYuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgICAgICAgICAgICAgaWYgKHF1ZXVlLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGZuID0gcXVldWUuc2hpZnQoKTtcbiAgICAgICAgICAgICAgICAgICAgZm4oKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sIHRydWUpO1xuXG4gICAgICAgIHJldHVybiBmdW5jdGlvbiBuZXh0VGljayhmbikge1xuICAgICAgICAgICAgcXVldWUucHVzaChmbik7XG4gICAgICAgICAgICB3aW5kb3cucG9zdE1lc3NhZ2UoJ3Byb2Nlc3MtdGljaycsICcqJyk7XG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgcmV0dXJuIGZ1bmN0aW9uIG5leHRUaWNrKGZuKSB7XG4gICAgICAgIHNldFRpbWVvdXQoZm4sIDApO1xuICAgIH07XG59KSgpO1xuXG5wcm9jZXNzLnRpdGxlID0gJ2Jyb3dzZXInO1xucHJvY2Vzcy5icm93c2VyID0gdHJ1ZTtcbnByb2Nlc3MuZW52ID0ge307XG5wcm9jZXNzLmFyZ3YgPSBbXTtcblxuZnVuY3Rpb24gbm9vcCgpIHt9XG5cbnByb2Nlc3Mub24gPSBub29wO1xucHJvY2Vzcy5hZGRMaXN0ZW5lciA9IG5vb3A7XG5wcm9jZXNzLm9uY2UgPSBub29wO1xucHJvY2Vzcy5vZmYgPSBub29wO1xucHJvY2Vzcy5yZW1vdmVMaXN0ZW5lciA9IG5vb3A7XG5wcm9jZXNzLnJlbW92ZUFsbExpc3RlbmVycyA9IG5vb3A7XG5wcm9jZXNzLmVtaXQgPSBub29wO1xuXG5wcm9jZXNzLmJpbmRpbmcgPSBmdW5jdGlvbiAobmFtZSkge1xuICAgIHRocm93IG5ldyBFcnJvcigncHJvY2Vzcy5iaW5kaW5nIGlzIG5vdCBzdXBwb3J0ZWQnKTtcbn07XG5cbi8vIFRPRE8oc2h0eWxtYW4pXG5wcm9jZXNzLmN3ZCA9IGZ1bmN0aW9uICgpIHsgcmV0dXJuICcvJyB9O1xucHJvY2Vzcy5jaGRpciA9IGZ1bmN0aW9uIChkaXIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ3Byb2Nlc3MuY2hkaXIgaXMgbm90IHN1cHBvcnRlZCcpO1xufTtcbiIsIihmdW5jdGlvbiAocm9vdCwgZmFjdG9yeSkge1xuICAgICd1c2Ugc3RyaWN0JztcbiAgICAvLyBVbml2ZXJzYWwgTW9kdWxlIERlZmluaXRpb24gKFVNRCkgdG8gc3VwcG9ydCBBTUQsIENvbW1vbkpTL05vZGUuanMsIFJoaW5vLCBhbmQgYnJvd3NlcnMuXG4gICAgaWYgKHR5cGVvZiBkZWZpbmUgPT09ICdmdW5jdGlvbicgJiYgZGVmaW5lLmFtZCkge1xuICAgICAgICBkZWZpbmUoJ2Vycm9yLXN0YWNrLXBhcnNlcicsIFsnc3RhY2tmcmFtZSddLCBmYWN0b3J5KTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBleHBvcnRzID09PSAnb2JqZWN0Jykge1xuICAgICAgICBtb2R1bGUuZXhwb3J0cyA9IGZhY3RvcnkocmVxdWlyZSgnc3RhY2tmcmFtZScpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICByb290LkVycm9yU3RhY2tQYXJzZXIgPSBmYWN0b3J5KHJvb3QuU3RhY2tGcmFtZSk7XG4gICAgfVxufSh0aGlzLCBmdW5jdGlvbiBFcnJvclN0YWNrUGFyc2VyKFN0YWNrRnJhbWUpIHtcbiAgICAndXNlIHN0cmljdCc7XG5cbiAgICAvLyBFUzUgUG9seWZpbGxzXG4gICAgLy8gU2VlIGh0dHBzOi8vZGV2ZWxvcGVyLm1vemlsbGEub3JnL2VuLVVTL2RvY3MvV2ViL0phdmFTY3JpcHQvUmVmZXJlbmNlL0dsb2JhbF9PYmplY3RzL0FycmF5L21hcFxuICAgIGlmICghQXJyYXkucHJvdG90eXBlLm1hcCkge1xuICAgICAgICBBcnJheS5wcm90b3R5cGUubWFwID0gZnVuY3Rpb24oY2FsbGJhY2ssIHRoaXNBcmcpIHtcbiAgICAgICAgICAgIHZhciBPID0gT2JqZWN0KHRoaXMpO1xuICAgICAgICAgICAgdmFyIGxlbiA9IE8ubGVuZ3RoID4+PiAwO1xuICAgICAgICAgICAgdmFyIFQ7XG4gICAgICAgICAgICBpZiAoYXJndW1lbnRzLmxlbmd0aCA+IDEpIHtcbiAgICAgICAgICAgICAgICBUID0gdGhpc0FyZztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdmFyIEEgPSBuZXcgQXJyYXkobGVuKTtcbiAgICAgICAgICAgIHZhciBrID0gMDtcblxuICAgICAgICAgICAgd2hpbGUgKGsgPCBsZW4pIHtcbiAgICAgICAgICAgICAgICB2YXIga1ZhbHVlLCBtYXBwZWRWYWx1ZTtcbiAgICAgICAgICAgICAgICBpZiAoayBpbiBPKSB7XG4gICAgICAgICAgICAgICAgICAgIGtWYWx1ZSA9IE9ba107XG4gICAgICAgICAgICAgICAgICAgIG1hcHBlZFZhbHVlID0gY2FsbGJhY2suY2FsbChULCBrVmFsdWUsIGssIE8pO1xuICAgICAgICAgICAgICAgICAgICBBW2tdID0gbWFwcGVkVmFsdWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGsrKztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIEE7XG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gU2VlIGh0dHBzOi8vZGV2ZWxvcGVyLm1vemlsbGEub3JnL2VuLVVTL2RvY3MvV2ViL0phdmFTY3JpcHQvUmVmZXJlbmNlL0dsb2JhbF9PYmplY3RzL0FycmF5L2ZpbHRlclxuICAgIGlmICghQXJyYXkucHJvdG90eXBlLmZpbHRlcikge1xuICAgICAgICBBcnJheS5wcm90b3R5cGUuZmlsdGVyID0gZnVuY3Rpb24oY2FsbGJhY2svKiwgdGhpc0FyZyovKSB7XG4gICAgICAgICAgICB2YXIgdCA9IE9iamVjdCh0aGlzKTtcbiAgICAgICAgICAgIHZhciBsZW4gPSB0Lmxlbmd0aCA+Pj4gMDtcblxuICAgICAgICAgICAgdmFyIHJlcyA9IFtdO1xuICAgICAgICAgICAgdmFyIHRoaXNBcmcgPSBhcmd1bWVudHMubGVuZ3RoID49IDIgPyBhcmd1bWVudHNbMV0gOiB2b2lkIDA7XG4gICAgICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbjsgaSsrKSB7XG4gICAgICAgICAgICAgICAgaWYgKGkgaW4gdCkge1xuICAgICAgICAgICAgICAgICAgICB2YXIgdmFsID0gdFtpXTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGNhbGxiYWNrLmNhbGwodGhpc0FyZywgdmFsLCBpLCB0KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmVzLnB1c2godmFsKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHJlcztcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICB2YXIgRklSRUZPWF9TQUZBUklfU1RBQ0tfUkVHRVhQID0gL1xcUytcXDpcXGQrLztcbiAgICB2YXIgQ0hST01FX0lFX1NUQUNLX1JFR0VYUCA9IC9cXHMrYXQgLztcblxuICAgIHJldHVybiB7XG4gICAgICAgIC8qKlxuICAgICAgICAgKiBHaXZlbiBhbiBFcnJvciBvYmplY3QsIGV4dHJhY3QgdGhlIG1vc3QgaW5mb3JtYXRpb24gZnJvbSBpdC5cbiAgICAgICAgICogQHBhcmFtIGVycm9yIHtFcnJvcn1cbiAgICAgICAgICogQHJldHVybiBBcnJheVtTdGFja0ZyYW1lXVxuICAgICAgICAgKi9cbiAgICAgICAgcGFyc2U6IGZ1bmN0aW9uIEVycm9yU3RhY2tQYXJzZXIkJHBhcnNlKGVycm9yKSB7XG4gICAgICAgICAgICBpZiAodHlwZW9mIGVycm9yLnN0YWNrdHJhY2UgIT09ICd1bmRlZmluZWQnIHx8IHR5cGVvZiBlcnJvclsnb3BlcmEjc291cmNlbG9jJ10gIT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMucGFyc2VPcGVyYShlcnJvcik7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGVycm9yLnN0YWNrICYmIGVycm9yLnN0YWNrLm1hdGNoKENIUk9NRV9JRV9TVEFDS19SRUdFWFApKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMucGFyc2VWOE9ySUUoZXJyb3IpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChlcnJvci5zdGFjayAmJiBlcnJvci5zdGFjay5tYXRjaChGSVJFRk9YX1NBRkFSSV9TVEFDS19SRUdFWFApKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMucGFyc2VGRk9yU2FmYXJpKGVycm9yKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDYW5ub3QgcGFyc2UgZ2l2ZW4gRXJyb3Igb2JqZWN0Jyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sXG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIFNlcGFyYXRlIGxpbmUgYW5kIGNvbHVtbiBudW1iZXJzIGZyb20gYSBVUkwtbGlrZSBzdHJpbmcuXG4gICAgICAgICAqIEBwYXJhbSB1cmxMaWtlIFN0cmluZ1xuICAgICAgICAgKiBAcmV0dXJuIEFycmF5W1N0cmluZ11cbiAgICAgICAgICovXG4gICAgICAgIGV4dHJhY3RMb2NhdGlvbjogZnVuY3Rpb24gRXJyb3JTdGFja1BhcnNlciQkZXh0cmFjdExvY2F0aW9uKHVybExpa2UpIHtcbiAgICAgICAgICAgIHZhciBsb2NhdGlvblBhcnRzID0gdXJsTGlrZS5zcGxpdCgnOicpO1xuICAgICAgICAgICAgdmFyIGxhc3ROdW1iZXIgPSBsb2NhdGlvblBhcnRzLnBvcCgpO1xuICAgICAgICAgICAgdmFyIHBvc3NpYmxlTnVtYmVyID0gbG9jYXRpb25QYXJ0c1tsb2NhdGlvblBhcnRzLmxlbmd0aCAtIDFdO1xuICAgICAgICAgICAgaWYgKCFpc05hTihwYXJzZUZsb2F0KHBvc3NpYmxlTnVtYmVyKSkgJiYgaXNGaW5pdGUocG9zc2libGVOdW1iZXIpKSB7XG4gICAgICAgICAgICAgICAgdmFyIGxpbmVOdW1iZXIgPSBsb2NhdGlvblBhcnRzLnBvcCgpO1xuICAgICAgICAgICAgICAgIHJldHVybiBbbG9jYXRpb25QYXJ0cy5qb2luKCc6JyksIGxpbmVOdW1iZXIsIGxhc3ROdW1iZXJdO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gW2xvY2F0aW9uUGFydHMuam9pbignOicpLCBsYXN0TnVtYmVyLCB1bmRlZmluZWRdO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LFxuXG4gICAgICAgIHBhcnNlVjhPcklFOiBmdW5jdGlvbiBFcnJvclN0YWNrUGFyc2VyJCRwYXJzZVY4T3JJRShlcnJvcikge1xuICAgICAgICAgICAgcmV0dXJuIGVycm9yLnN0YWNrLnNwbGl0KCdcXG4nKS5zbGljZSgxKS5tYXAoZnVuY3Rpb24gKGxpbmUpIHtcbiAgICAgICAgICAgICAgICB2YXIgdG9rZW5zID0gbGluZS5yZXBsYWNlKC9eXFxzKy8sICcnKS5zcGxpdCgvXFxzKy8pLnNsaWNlKDEpO1xuICAgICAgICAgICAgICAgIHZhciBsb2NhdGlvblBhcnRzID0gdGhpcy5leHRyYWN0TG9jYXRpb24odG9rZW5zLnBvcCgpLnJlcGxhY2UoL1tcXChcXClcXHNdL2csICcnKSk7XG4gICAgICAgICAgICAgICAgdmFyIGZ1bmN0aW9uTmFtZSA9ICghdG9rZW5zWzBdIHx8IHRva2Vuc1swXSA9PT0gJ0Fub255bW91cycpID8gdW5kZWZpbmVkIDogdG9rZW5zWzBdO1xuICAgICAgICAgICAgICAgIHJldHVybiBuZXcgU3RhY2tGcmFtZShmdW5jdGlvbk5hbWUsIHVuZGVmaW5lZCwgbG9jYXRpb25QYXJ0c1swXSwgbG9jYXRpb25QYXJ0c1sxXSwgbG9jYXRpb25QYXJ0c1syXSk7XG4gICAgICAgICAgICB9LCB0aGlzKTtcbiAgICAgICAgfSxcblxuICAgICAgICBwYXJzZUZGT3JTYWZhcmk6IGZ1bmN0aW9uIEVycm9yU3RhY2tQYXJzZXIkJHBhcnNlRkZPclNhZmFyaShlcnJvcikge1xuICAgICAgICAgICAgcmV0dXJuIGVycm9yLnN0YWNrLnNwbGl0KCdcXG4nKS5maWx0ZXIoZnVuY3Rpb24gKGxpbmUpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gISFsaW5lLm1hdGNoKEZJUkVGT1hfU0FGQVJJX1NUQUNLX1JFR0VYUCk7XG4gICAgICAgICAgICB9LCB0aGlzKS5tYXAoZnVuY3Rpb24gKGxpbmUpIHtcbiAgICAgICAgICAgICAgICB2YXIgdG9rZW5zID0gbGluZS5zcGxpdCgnQCcpO1xuICAgICAgICAgICAgICAgIHZhciBsb2NhdGlvblBhcnRzID0gdGhpcy5leHRyYWN0TG9jYXRpb24odG9rZW5zLnBvcCgpKTtcbiAgICAgICAgICAgICAgICB2YXIgZnVuY3Rpb25OYW1lID0gdG9rZW5zLnNoaWZ0KCkgfHwgdW5kZWZpbmVkO1xuICAgICAgICAgICAgICAgIHJldHVybiBuZXcgU3RhY2tGcmFtZShmdW5jdGlvbk5hbWUsIHVuZGVmaW5lZCwgbG9jYXRpb25QYXJ0c1swXSwgbG9jYXRpb25QYXJ0c1sxXSwgbG9jYXRpb25QYXJ0c1syXSk7XG4gICAgICAgICAgICB9LCB0aGlzKTtcbiAgICAgICAgfSxcblxuICAgICAgICBwYXJzZU9wZXJhOiBmdW5jdGlvbiBFcnJvclN0YWNrUGFyc2VyJCRwYXJzZU9wZXJhKGUpIHtcbiAgICAgICAgICAgIGlmICghZS5zdGFja3RyYWNlIHx8IChlLm1lc3NhZ2UuaW5kZXhPZignXFxuJykgPiAtMSAmJlxuICAgICAgICAgICAgICAgIGUubWVzc2FnZS5zcGxpdCgnXFxuJykubGVuZ3RoID4gZS5zdGFja3RyYWNlLnNwbGl0KCdcXG4nKS5sZW5ndGgpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMucGFyc2VPcGVyYTkoZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFlLnN0YWNrKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMucGFyc2VPcGVyYTEwKGUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5wYXJzZU9wZXJhMTEoZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sXG5cbiAgICAgICAgcGFyc2VPcGVyYTk6IGZ1bmN0aW9uIEVycm9yU3RhY2tQYXJzZXIkJHBhcnNlT3BlcmE5KGUpIHtcbiAgICAgICAgICAgIHZhciBsaW5lUkUgPSAvTGluZSAoXFxkKykuKnNjcmlwdCAoPzppbiApPyhcXFMrKS9pO1xuICAgICAgICAgICAgdmFyIGxpbmVzID0gZS5tZXNzYWdlLnNwbGl0KCdcXG4nKTtcbiAgICAgICAgICAgIHZhciByZXN1bHQgPSBbXTtcblxuICAgICAgICAgICAgZm9yICh2YXIgaSA9IDIsIGxlbiA9IGxpbmVzLmxlbmd0aDsgaSA8IGxlbjsgaSArPSAyKSB7XG4gICAgICAgICAgICAgICAgdmFyIG1hdGNoID0gbGluZVJFLmV4ZWMobGluZXNbaV0pO1xuICAgICAgICAgICAgICAgIGlmIChtYXRjaCkge1xuICAgICAgICAgICAgICAgICAgICByZXN1bHQucHVzaChuZXcgU3RhY2tGcmFtZSh1bmRlZmluZWQsIHVuZGVmaW5lZCwgbWF0Y2hbMl0sIG1hdGNoWzFdKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICB9LFxuXG4gICAgICAgIHBhcnNlT3BlcmExMDogZnVuY3Rpb24gRXJyb3JTdGFja1BhcnNlciQkcGFyc2VPcGVyYTEwKGUpIHtcbiAgICAgICAgICAgIHZhciBsaW5lUkUgPSAvTGluZSAoXFxkKykuKnNjcmlwdCAoPzppbiApPyhcXFMrKSg/OjogSW4gZnVuY3Rpb24gKFxcUyspKT8kL2k7XG4gICAgICAgICAgICB2YXIgbGluZXMgPSBlLnN0YWNrdHJhY2Uuc3BsaXQoJ1xcbicpO1xuICAgICAgICAgICAgdmFyIHJlc3VsdCA9IFtdO1xuXG4gICAgICAgICAgICBmb3IgKHZhciBpID0gMCwgbGVuID0gbGluZXMubGVuZ3RoOyBpIDwgbGVuOyBpICs9IDIpIHtcbiAgICAgICAgICAgICAgICB2YXIgbWF0Y2ggPSBsaW5lUkUuZXhlYyhsaW5lc1tpXSk7XG4gICAgICAgICAgICAgICAgaWYgKG1hdGNoKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdC5wdXNoKG5ldyBTdGFja0ZyYW1lKG1hdGNoWzNdIHx8IHVuZGVmaW5lZCwgdW5kZWZpbmVkLCBtYXRjaFsyXSwgbWF0Y2hbMV0pKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0sXG5cbiAgICAgICAgLy8gT3BlcmEgMTAuNjUrIEVycm9yLnN0YWNrIHZlcnkgc2ltaWxhciB0byBGRi9TYWZhcmlcbiAgICAgICAgcGFyc2VPcGVyYTExOiBmdW5jdGlvbiBFcnJvclN0YWNrUGFyc2VyJCRwYXJzZU9wZXJhMTEoZXJyb3IpIHtcbiAgICAgICAgICAgIHJldHVybiBlcnJvci5zdGFjay5zcGxpdCgnXFxuJykuZmlsdGVyKGZ1bmN0aW9uIChsaW5lKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuICEhbGluZS5tYXRjaChGSVJFRk9YX1NBRkFSSV9TVEFDS19SRUdFWFApICYmXG4gICAgICAgICAgICAgICAgICAgICFsaW5lLm1hdGNoKC9eRXJyb3IgY3JlYXRlZCBhdC8pO1xuICAgICAgICAgICAgfSwgdGhpcykubWFwKGZ1bmN0aW9uIChsaW5lKSB7XG4gICAgICAgICAgICAgICAgdmFyIHRva2VucyA9IGxpbmUuc3BsaXQoJ0AnKTtcbiAgICAgICAgICAgICAgICB2YXIgbG9jYXRpb25QYXJ0cyA9IHRoaXMuZXh0cmFjdExvY2F0aW9uKHRva2Vucy5wb3AoKSk7XG4gICAgICAgICAgICAgICAgdmFyIGZ1bmN0aW9uQ2FsbCA9ICh0b2tlbnMuc2hpZnQoKSB8fCAnJyk7XG4gICAgICAgICAgICAgICAgdmFyIGZ1bmN0aW9uTmFtZSA9IGZ1bmN0aW9uQ2FsbFxuICAgICAgICAgICAgICAgICAgICAgICAgLnJlcGxhY2UoLzxhbm9ueW1vdXMgZnVuY3Rpb24oOiAoXFx3KykpPz4vLCAnJDInKVxuICAgICAgICAgICAgICAgICAgICAgICAgLnJlcGxhY2UoL1xcKFteXFwpXSpcXCkvZywgJycpIHx8IHVuZGVmaW5lZDtcbiAgICAgICAgICAgICAgICB2YXIgYXJnc1JhdztcbiAgICAgICAgICAgICAgICBpZiAoZnVuY3Rpb25DYWxsLm1hdGNoKC9cXCgoW15cXCldKilcXCkvKSkge1xuICAgICAgICAgICAgICAgICAgICBhcmdzUmF3ID0gZnVuY3Rpb25DYWxsLnJlcGxhY2UoL15bXlxcKF0rXFwoKFteXFwpXSopXFwpJC8sICckMScpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB2YXIgYXJncyA9IChhcmdzUmF3ID09PSB1bmRlZmluZWQgfHwgYXJnc1JhdyA9PT0gJ1thcmd1bWVudHMgbm90IGF2YWlsYWJsZV0nKSA/IHVuZGVmaW5lZCA6IGFyZ3NSYXcuc3BsaXQoJywnKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gbmV3IFN0YWNrRnJhbWUoZnVuY3Rpb25OYW1lLCBhcmdzLCBsb2NhdGlvblBhcnRzWzBdLCBsb2NhdGlvblBhcnRzWzFdLCBsb2NhdGlvblBhcnRzWzJdKTtcbiAgICAgICAgICAgIH0sIHRoaXMpO1xuICAgICAgICB9XG4gICAgfTtcbn0pKTtcblxuIiwiKGZ1bmN0aW9uIChyb290LCBmYWN0b3J5KSB7XG4gICAgJ3VzZSBzdHJpY3QnO1xuICAgIC8vIFVuaXZlcnNhbCBNb2R1bGUgRGVmaW5pdGlvbiAoVU1EKSB0byBzdXBwb3J0IEFNRCwgQ29tbW9uSlMvTm9kZS5qcywgUmhpbm8sIGFuZCBicm93c2Vycy5cbiAgICBpZiAodHlwZW9mIGRlZmluZSA9PT0gJ2Z1bmN0aW9uJyAmJiBkZWZpbmUuYW1kKSB7XG4gICAgICAgIGRlZmluZShbXSwgZmFjdG9yeSk7XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgZXhwb3J0cyA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgbW9kdWxlLmV4cG9ydHMgPSBmYWN0b3J5KCk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgcm9vdC5TdGFja0ZyYW1lID0gZmFjdG9yeSgpO1xuICAgIH1cbn0odGhpcywgZnVuY3Rpb24gKCkge1xuICAgICd1c2Ugc3RyaWN0JztcbiAgICBmdW5jdGlvbiBfaXNOdW1iZXIobikge1xuICAgICAgICByZXR1cm4gIWlzTmFOKHBhcnNlRmxvYXQobikpICYmIGlzRmluaXRlKG4pO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIFN0YWNrRnJhbWUoZnVuY3Rpb25OYW1lLCBhcmdzLCBmaWxlTmFtZSwgbGluZU51bWJlciwgY29sdW1uTnVtYmVyKSB7XG4gICAgICAgIGlmIChmdW5jdGlvbk5hbWUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgdGhpcy5zZXRGdW5jdGlvbk5hbWUoZnVuY3Rpb25OYW1lKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoYXJncyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICB0aGlzLnNldEFyZ3MoYXJncyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGZpbGVOYW1lICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgIHRoaXMuc2V0RmlsZU5hbWUoZmlsZU5hbWUpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChsaW5lTnVtYmVyICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgIHRoaXMuc2V0TGluZU51bWJlcihsaW5lTnVtYmVyKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoY29sdW1uTnVtYmVyICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgIHRoaXMuc2V0Q29sdW1uTnVtYmVyKGNvbHVtbk51bWJlcik7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBTdGFja0ZyYW1lLnByb3RvdHlwZSA9IHtcbiAgICAgICAgZ2V0RnVuY3Rpb25OYW1lOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5mdW5jdGlvbk5hbWU7XG4gICAgICAgIH0sXG4gICAgICAgIHNldEZ1bmN0aW9uTmFtZTogZnVuY3Rpb24gKHYpIHtcbiAgICAgICAgICAgIHRoaXMuZnVuY3Rpb25OYW1lID0gU3RyaW5nKHYpO1xuICAgICAgICB9LFxuXG4gICAgICAgIGdldEFyZ3M6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmFyZ3M7XG4gICAgICAgIH0sXG4gICAgICAgIHNldEFyZ3M6IGZ1bmN0aW9uICh2KSB7XG4gICAgICAgICAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZy5jYWxsKHYpICE9PSAnW29iamVjdCBBcnJheV0nKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignQXJncyBtdXN0IGJlIGFuIEFycmF5Jyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB0aGlzLmFyZ3MgPSB2O1xuICAgICAgICB9LFxuXG4gICAgICAgIC8vIE5PVEU6IFByb3BlcnR5IG5hbWUgbWF5IGJlIG1pc2xlYWRpbmcgYXMgaXQgaW5jbHVkZXMgdGhlIHBhdGgsXG4gICAgICAgIC8vIGJ1dCBpdCBzb21ld2hhdCBtaXJyb3JzIFY4J3MgSmF2YVNjcmlwdFN0YWNrVHJhY2VBcGlcbiAgICAgICAgLy8gaHR0cHM6Ly9jb2RlLmdvb2dsZS5jb20vcC92OC93aWtpL0phdmFTY3JpcHRTdGFja1RyYWNlQXBpXG4gICAgICAgIGdldEZpbGVOYW1lOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5maWxlTmFtZTtcbiAgICAgICAgfSxcbiAgICAgICAgc2V0RmlsZU5hbWU6IGZ1bmN0aW9uICh2KSB7XG4gICAgICAgICAgICB0aGlzLmZpbGVOYW1lID0gU3RyaW5nKHYpO1xuICAgICAgICB9LFxuXG4gICAgICAgIGdldExpbmVOdW1iZXI6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmxpbmVOdW1iZXI7XG4gICAgICAgIH0sXG4gICAgICAgIHNldExpbmVOdW1iZXI6IGZ1bmN0aW9uICh2KSB7XG4gICAgICAgICAgICBpZiAoIV9pc051bWJlcih2KSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ0xpbmUgTnVtYmVyIG11c3QgYmUgYSBOdW1iZXInKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRoaXMubGluZU51bWJlciA9IE51bWJlcih2KTtcbiAgICAgICAgfSxcblxuICAgICAgICBnZXRDb2x1bW5OdW1iZXI6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmNvbHVtbk51bWJlcjtcbiAgICAgICAgfSxcbiAgICAgICAgc2V0Q29sdW1uTnVtYmVyOiBmdW5jdGlvbiAodikge1xuICAgICAgICAgICAgaWYgKCFfaXNOdW1iZXIodikpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdDb2x1bW4gTnVtYmVyIG11c3QgYmUgYSBOdW1iZXInKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRoaXMuY29sdW1uTnVtYmVyID0gTnVtYmVyKHYpO1xuICAgICAgICB9LFxuXG4gICAgICAgIHRvU3RyaW5nOiBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgIHZhciBmdW5jdGlvbk5hbWUgPSB0aGlzLmdldEZ1bmN0aW9uTmFtZSgpIHx8ICd7YW5vbnltb3VzfSc7XG4gICAgICAgICAgICB2YXIgYXJncyA9ICcoJyArICh0aGlzLmdldEFyZ3MoKSB8fCBbXSkuam9pbignLCcpICsgJyknO1xuICAgICAgICAgICAgdmFyIGZpbGVOYW1lID0gdGhpcy5nZXRGaWxlTmFtZSgpID8gKCdAJyArIHRoaXMuZ2V0RmlsZU5hbWUoKSkgOiAnJztcbiAgICAgICAgICAgIHZhciBsaW5lTnVtYmVyID0gX2lzTnVtYmVyKHRoaXMuZ2V0TGluZU51bWJlcigpKSA/ICgnOicgKyB0aGlzLmdldExpbmVOdW1iZXIoKSkgOiAnJztcbiAgICAgICAgICAgIHZhciBjb2x1bW5OdW1iZXIgPSBfaXNOdW1iZXIodGhpcy5nZXRDb2x1bW5OdW1iZXIoKSkgPyAoJzonICsgdGhpcy5nZXRDb2x1bW5OdW1iZXIoKSkgOiAnJztcbiAgICAgICAgICAgIHJldHVybiBmdW5jdGlvbk5hbWUgKyBhcmdzICsgZmlsZU5hbWUgKyBsaW5lTnVtYmVyICsgY29sdW1uTnVtYmVyO1xuICAgICAgICB9XG4gICAgfTtcblxuICAgIHJldHVybiBTdGFja0ZyYW1lO1xufSkpO1xuIl19
