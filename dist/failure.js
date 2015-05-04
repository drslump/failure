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

// Annotation symbols
var SYMBOL_FRAMES = '@@failure/frames';
var SYMBOL_IGNORE = '@@failure/ignore';


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
  return new NativeError();
};
// Some engines do not generate the .stack property until it's thrown
if (!getErrorWithStack().stack) {
  getErrorWithStack = function () {
    try { throw new NativeError(); } catch (e) { return e; }
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

    if (!fn || !fn[SYMBOL_IGNORE]) {
      result.push(frames[i]);
    }

    if (fn && fn[SYMBOL_FRAMES]) {
      if (Failure.FRAME_EMPTY) {
        result.push(null);
      }

      // Call the getter and keep a reference to the result in case we have to
      // unwind the same function another time.
      // TODO: Make sure keeping a reference to the frames doesn't create leaks
      if (typeof fn[SYMBOL_FRAMES] === 'function') {
        var getter = fn[SYMBOL_FRAMES];
        fn[SYMBOL_FRAMES] = null;
        fn[SYMBOL_FRAMES] = getter();
      }

      if (!fn[SYMBOL_FRAMES]) {
        console.warn('[Failure] Empty frames annotation');
        continue;
      }

      result.push.apply(result, unwind(fn[SYMBOL_FRAMES]));
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
  if (typeof fn[SYMBOL_FRAMES] === 'function') {
    fn[SYMBOL_FRAMES](true);
  }

  if (Failure.TRACK) {
    fn[SYMBOL_FRAMES] = null;
    fn[SYMBOL_FRAMES] = makeFramesGetter(sff || Failure_track);
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
  fn[SYMBOL_IGNORE] = true;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJsaWIvY2FsbC1zaXRlLmpzIiwibGliL2ZhaWx1cmUuanMiLCJtYWluLmpzIiwibm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL3Byb2Nlc3MvYnJvd3Nlci5qcyIsIm5vZGVfbW9kdWxlcy9lcnJvci1zdGFjay1wYXJzZXIvZXJyb3Itc3RhY2stcGFyc2VyLmpzIiwibm9kZV9tb2R1bGVzL2Vycm9yLXN0YWNrLXBhcnNlci9ub2RlX21vZHVsZXMvc3RhY2tmcmFtZS9zdGFja2ZyYW1lLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO0FDQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FDN0RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDbGNBO0FBQ0E7QUFDQTtBQUNBOztBQ0hBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0RkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN4TEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSIsImZpbGUiOiJnZW5lcmF0ZWQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uIGUodCxuLHIpe2Z1bmN0aW9uIHMobyx1KXtpZighbltvXSl7aWYoIXRbb10pe3ZhciBhPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7aWYoIXUmJmEpcmV0dXJuIGEobywhMCk7aWYoaSlyZXR1cm4gaShvLCEwKTt2YXIgZj1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK28rXCInXCIpO3Rocm93IGYuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixmfXZhciBsPW5bb109e2V4cG9ydHM6e319O3Rbb11bMF0uY2FsbChsLmV4cG9ydHMsZnVuY3Rpb24oZSl7dmFyIG49dFtvXVsxXVtlXTtyZXR1cm4gcyhuP246ZSl9LGwsbC5leHBvcnRzLGUsdCxuLHIpfXJldHVybiBuW29dLmV4cG9ydHN9dmFyIGk9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtmb3IodmFyIG89MDtvPHIubGVuZ3RoO28rKylzKHJbb10pO3JldHVybiBzfSkiLCIvLyBFbXVsYXRlcyBWOCdzIENhbGxTaXRlIG9iamVjdCBmcm9tIGEgc3RhY2t0cmFjZS5qcyBmcmFtZSBvYmplY3RcblxuZnVuY3Rpb24gQ2FsbFNpdGUgKGZyYW1lKSB7XG4gIGlmICghKHRoaXMgaW5zdGFuY2VvZiBDYWxsU2l0ZSkpIHtcbiAgICByZXR1cm4gbmV3IENhbGxTaXRlKGZyYW1lKTtcbiAgfVxuICB0aGlzLmZyYW1lID0gZnJhbWU7XG59O1xuXG5DYWxsU2l0ZS5wcm90b3R5cGUgPSBPYmplY3QuY3JlYXRlKHtcbiAgZ2V0TGluZU51bWJlcjogZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiB0aGlzLmZyYW1lLmxpbmVOdW1iZXI7XG4gIH0sXG4gIGdldENvbHVtbk51bWJlcjogZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiB0aGlzLmZyYW1lLmNvbHVtbk51bWJlcjtcbiAgfSxcbiAgZ2V0RmlsZU5hbWU6IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gdGhpcy5mcmFtZS5maWxlTmFtZTtcbiAgfSxcbiAgZ2V0RnVuY3Rpb246IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gdGhpcy5mcmFtZS5mdW5jdGlvbjtcbiAgfSxcbiAgZ2V0VGhpczogZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiBudWxsO1xuICB9LFxuICBnZXRUeXBlTmFtZTogZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiBudWxsO1xuICB9LFxuICBnZXRNZXRob2ROYW1lOiBmdW5jdGlvbiAoKSB7XG4gICAgaWYgKHRoaXMuZnJhbWUuZnVuY3Rpb25OYW1lKSB7XG4gICAgICByZXR1cm4gdGhpcy5mcmFtZS5mdW5jdGlvbk5hbWUuc3BsaXQoJy4nKS5wb3AoKTtcbiAgICB9XG4gICAgcmV0dXJuIG51bGw7XG4gIH0sXG4gIGdldEZ1bmN0aW9uTmFtZTogZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiB0aGlzLmZyYW1lLmZ1bmN0aW9uTmFtZTtcbiAgfSxcbiAgZ2V0RXZhbE9yaWdpbjogZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiBudWxsO1xuICB9LFxuICBpc1RvcGxldmVsOiBmdW5jdGlvbiAoKSB7XG4gICAgcmV0dXJuIGZhbHNlOyAvLyBUT0RPXG4gIH0sXG4gIGlzRXZhbDogZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiBmYWxzZTsgLy8gVE9ET1xuICB9LFxuICBpc05hdGl2ZTogZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiBmYWxzZTsgLy8gVE9ET1xuICB9LFxuICBpc0NvbnN0cnVjdG9yOiBmdW5jdGlvbiAoKSB7XG4gICAgcmV0dXJuIC9ebmV3KFxcc3wkKS8udGVzdCh0aGlzLmZyYW1lLmZ1bmN0aW9uTmFtZSk7XG4gIH0sXG4gIHRvU3RyaW5nOiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIG5hbWUgPSB0aGlzLmdldEZ1bmN0aW9uTmFtZSgpIHx8ICc8YW5vbnltb3VzPic7XG4gICAgdmFyIGxvYyA9IHRoaXMuZ2V0RmlsZU5hbWUoKSArICc6JyArIHRoaXMuZ2V0TGluZU51bWJlcigpICsgJzonICsgdGhpcy5nZXRDb2x1bW5OdW1iZXIoKVxuICAgIHJldHVybiBuYW1lICsgJyAoJyArIGxvYyArICcpJztcbiAgfVxufSk7XG5cblxubW9kdWxlLmV4cG9ydHMgPSBDYWxsU2l0ZTtcbiIsInZhciBFcnJvclN0YWNrUGFyc2VyID0gcmVxdWlyZSgnZXJyb3Itc3RhY2stcGFyc2VyJyk7XG52YXIgQ2FsbFNpdGUgPSByZXF1aXJlKCcuL2NhbGwtc2l0ZScpO1xuXG4vLyBLZWVwIGEgcmVmZXJlbmNlIHRvIHRoZSBidWlsdGluIGVycm9yIGNvbnN0cnVjdG9yXG52YXIgTmF0aXZlRXJyb3IgPSBFcnJvcjtcblxuLy8gQW5ub3RhdGlvbiBzeW1ib2xzXG52YXIgU1lNQk9MX0ZSQU1FUyA9ICdAQGZhaWx1cmUvZnJhbWVzJztcbnZhciBTWU1CT0xfSUdOT1JFID0gJ0BAZmFpbHVyZS9pZ25vcmUnO1xuXG5cbmZ1bmN0aW9uIEZhaWx1cmUgKG1lc3NhZ2UsIHNmZikge1xuICBpZiAoISh0aGlzIGluc3RhbmNlb2YgRmFpbHVyZSkpIHtcbiAgICByZXR1cm4gbmV3IEZhaWx1cmUobWVzc2FnZSwgc2ZmIHx8IEZhaWx1cmUpO1xuICB9XG5cbiAgdGhpcy5zZmYgPSBzZmYgfHwgdGhpcy5jb25zdHJ1Y3RvcjtcblxuICB0aGlzLm1lc3NhZ2UgPSBtZXNzYWdlO1xuXG4gIC8vIEdlbmVyYXRlIGEgZ2V0dGVyIGZvciB0aGUgZnJhbWVzLCB0aGlzIGVuc3VyZXMgdGhhdCB3ZSBkbyBhcyBsaXR0bGUgd29ya1xuICAvLyBhcyBwb3NzaWJsZSB3aGVuIGluc3RhbnRpYXRpbmcgdGhlIGVycm9yLCBkZWZlcnJpbmcgdGhlIGV4cGVuc2l2ZSBzdGFja1xuICAvLyBtYW5nbGluZyBvcGVyYXRpb25zIHVudGlsIHRoZSAuc3RhY2sgcHJvcGVydHkgaXMgYWN0dWFsbHkgcmVxdWVzdGVkLlxuICB0aGlzLl9nZXRGcmFtZXMgPSBtYWtlRnJhbWVzR2V0dGVyKHRoaXMuc2ZmKTtcblxuICAvLyBPbiBFUzUgZW5naW5lcyB3ZSB1c2Ugb25lLXRpbWUgZ2V0dGVycyB0byBhY3R1YWxseSBkZWZlciB0aGUgZXhwZW5zaXZlXG4gIC8vIG9wZXJhdGlvbnMgKGRlZmluZWQgaW4gdGhlIHByb3RvdHlwZSBmb3IgcGVyZm9ybWFuY2UgcmVhc29ucykgd2hpbGUgbGVnYWN5XG4gIC8vIGVuZ2luZXMgd2lsbCBzaW1wbHkgZG8gYWxsIHRoZSB3b3JrIHVwIGZyb250LlxuICBpZiAodHlwZW9mIE9iamVjdC5kZWZpbmVQcm9wZXJ0eSAhPT0gJ2Z1bmN0aW9uJykge1xuICAgIHRoaXMuZnJhbWVzID0gdW53aW5kKHRoaXMuX2dldEZyYW1lcygpKTtcbiAgICB0aGlzLl9nZXRGcmFtZXModHJ1ZSk7XG4gICAgdGhpcy5fZ2V0RnJhbWVzID0gbnVsbDtcbiAgICB0aGlzLnN0YWNrID0gdGhpcy5nZW5lcmF0ZVN0YWNrVHJhY2UoKTtcbiAgfVxuXG4gIHJldHVybiB0aGlzO1xufVxuXG4vLyBTZXQgRlJBTUVfRU1QVFkgdG8gbnVsbCB0byBkaXNhYmxlIGFueSBzb3J0IG9mIHNlcGFyYXRvclxuRmFpbHVyZS5GUkFNRV9FTVBUWSA9ICcgIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0nO1xuRmFpbHVyZS5GUkFNRV9QUkVGSVggPSAnICBhdCAnO1xuXG4vLyBCeSBkZWZhdWx0IHdlIGVuYWJsZSB0cmFja2luZyBmb3IgYXN5bmMgc3RhY2sgdHJhY2VzXG5GYWlsdXJlLlRSQUNLID0gdHJ1ZTtcblxuXG4vLyBIZWxwZXIgdG8gb2J0YWluIHRoZSBjdXJyZW50IHN0YWNrIHRyYWNlXG52YXIgZ2V0RXJyb3JXaXRoU3RhY2sgPSBmdW5jdGlvbiAoKSB7XG4gIHJldHVybiBuZXcgTmF0aXZlRXJyb3IoKTtcbn07XG4vLyBTb21lIGVuZ2luZXMgZG8gbm90IGdlbmVyYXRlIHRoZSAuc3RhY2sgcHJvcGVydHkgdW50aWwgaXQncyB0aHJvd25cbmlmICghZ2V0RXJyb3JXaXRoU3RhY2soKS5zdGFjaykge1xuICBnZXRFcnJvcldpdGhTdGFjayA9IGZ1bmN0aW9uICgpIHtcbiAgICB0cnkgeyB0aHJvdyBuZXcgTmF0aXZlRXJyb3IoKTsgfSBjYXRjaCAoZSkgeyByZXR1cm4gZTsgfVxuICB9O1xufVxuXG4vLyBUcmltIGZyYW1lcyB1bmRlciB0aGUgcHJvdmlkZWQgc3RhY2sgZmlyc3QgZnVuY3Rpb25cbmZ1bmN0aW9uIHRyaW0oZnJhbWVzLCBzZmYpIHtcbiAgdmFyIGZuLCBuYW1lID0gc2ZmLm5hbWU7XG4gIGlmICghZnJhbWVzKSB7XG4gICAgY29uc29sZS5sb2coJ1tGYWlsdXJlXSBlcnJvciBjYXB0dXJpbmcgZnJhbWVzJyk7XG4gICAgcmV0dXJuIFtdO1xuICB9XG4gIGZvciAodmFyIGk9MDsgaSA8IGZyYW1lcy5sZW5ndGg7IGkrKykge1xuICAgIGZuID0gZnJhbWVzW2ldLmdldEZ1bmN0aW9uKCk7XG4gICAgaWYgKGZuICYmIGZuID09PSBzZmYgfHwgbmFtZSAmJiBuYW1lID09PSBmcmFtZXNbaV0uZ2V0RnVuY3Rpb25OYW1lKCkpIHtcbiAgICAgIHJldHVybiBmcmFtZXMuc2xpY2UoaSArIDEpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gZnJhbWVzO1xufVxuXG5mdW5jdGlvbiB1bndpbmQgKGZyYW1lcykge1xuICB2YXIgcmVzdWx0ID0gW107XG5cbiAgZm9yICh2YXIgaT0wLCBmbjsgaSA8IGZyYW1lcy5sZW5ndGg7IGkrKykge1xuICAgIGZuID0gZnJhbWVzW2ldLmdldEZ1bmN0aW9uKCk7XG5cbiAgICBpZiAoIWZuIHx8ICFmbltTWU1CT0xfSUdOT1JFXSkge1xuICAgICAgcmVzdWx0LnB1c2goZnJhbWVzW2ldKTtcbiAgICB9XG5cbiAgICBpZiAoZm4gJiYgZm5bU1lNQk9MX0ZSQU1FU10pIHtcbiAgICAgIGlmIChGYWlsdXJlLkZSQU1FX0VNUFRZKSB7XG4gICAgICAgIHJlc3VsdC5wdXNoKG51bGwpO1xuICAgICAgfVxuXG4gICAgICAvLyBDYWxsIHRoZSBnZXR0ZXIgYW5kIGtlZXAgYSByZWZlcmVuY2UgdG8gdGhlIHJlc3VsdCBpbiBjYXNlIHdlIGhhdmUgdG9cbiAgICAgIC8vIHVud2luZCB0aGUgc2FtZSBmdW5jdGlvbiBhbm90aGVyIHRpbWUuXG4gICAgICAvLyBUT0RPOiBNYWtlIHN1cmUga2VlcGluZyBhIHJlZmVyZW5jZSB0byB0aGUgZnJhbWVzIGRvZXNuJ3QgY3JlYXRlIGxlYWtzXG4gICAgICBpZiAodHlwZW9mIGZuW1NZTUJPTF9GUkFNRVNdID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIHZhciBnZXR0ZXIgPSBmbltTWU1CT0xfRlJBTUVTXTtcbiAgICAgICAgZm5bU1lNQk9MX0ZSQU1FU10gPSBudWxsO1xuICAgICAgICBmbltTWU1CT0xfRlJBTUVTXSA9IGdldHRlcigpO1xuICAgICAgfVxuXG4gICAgICBpZiAoIWZuW1NZTUJPTF9GUkFNRVNdKSB7XG4gICAgICAgIGNvbnNvbGUud2FybignW0ZhaWx1cmVdIEVtcHR5IGZyYW1lcyBhbm5vdGF0aW9uJyk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICByZXN1bHQucHVzaC5hcHBseShyZXN1bHQsIHVud2luZChmbltTWU1CT0xfRlJBTUVTXSkpO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHJlc3VsdDtcbn1cblxuLy8gUmVjZWl2ZXIgZm9yIHRoZSBmcmFtZXMgaW4gYSAuc3RhY2sgcHJvcGVydHkgZnJvbSBjYXB0dXJlU3RhY2tUcmFjZVxudmFyIFY4RlJBTUVTID0ge307XG5cbi8vIFY4IGNvZGUgcGF0aCBmb3IgZ2VuZXJhdGluZyBhIGZyYW1lcyBnZXR0ZXJcbmZ1bmN0aW9uIG1ha2VGcmFtZXNHZXR0ZXJWOCAoc2ZmKSB7XG4gIE5hdGl2ZUVycm9yLmNhcHR1cmVTdGFja1RyYWNlKFY4RlJBTUVTLCBzZmYgfHwgbWFrZUZyYW1lc0dldHRlclY4KTtcbiAgc2ZmID0gbnVsbDtcbiAgdmFyIGZyYW1lcyA9IFY4RlJBTUVTLnN0YWNrO1xuICBWOEZSQU1FUy5zdGFjayA9IG51bGw7ICAvLyBJTVBPUlRBTlQ6IFRoaXMgaXMgbmVlZGVkIHRvIGF2b2lkIGxlYWtzISEhXG4gIHJldHVybiBmdW5jdGlvbiAoY2xlYW51cCkge1xuICAgIHZhciByZXN1bHQgPSBmcmFtZXM7XG4gICAgLy8gQ2xlYW4gdXAgY2xvc3VyZSB2YXJpYWJsZXMgdG8gaGVscCBHQ1xuICAgIGZyYW1lcyA9IG51bGw7XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfTtcbn1cblxuLy8gbm9uLVY4IGNvZGUgcGF0aCBmb3IgZ2VuZXJhdGluZyBhIGZyYW1lcyBnZXR0ZXJcbmZ1bmN0aW9uIG1ha2VGcmFtZXNHZXR0ZXJDb21wYXQgKHNmZikge1xuICAvLyBPYnRhaW4gYSBzdGFjayB0cmFjZSBhdCB0aGUgY3VycmVudCBwb2ludFxuICB2YXIgZXJyb3IgPSBnZXRFcnJvcldpdGhTdGFjaygpO1xuXG4gIC8vIFdhbGsgdGhlIGNhbGxlciBjaGFpbiB0byBhbm5vdGF0ZSB0aGUgc3RhY2sgd2l0aCBmdW5jdGlvbiByZWZlcmVuY2VzXG4gIC8vIEdpdmVuIHRoZSBsaW1pdGF0aW9ucyBpbXBvc2VkIGJ5IEVTNSBcInN0cmljdCBtb2RlXCIgaXQncyBub3QgcG9zc2libGVcbiAgLy8gdG8gb2J0YWluIHJlZmVyZW5jZXMgdG8gZnVuY3Rpb25zIGJleW9uZCBvbmUgdGhhdCBpcyBkZWZpbmVkIGluIHN0cmljdFxuICAvLyBtb2RlLiBBbHNvIG5vdGUgdGhhdCBhbnkga2luZCBvZiByZWN1cnNpb24gd2lsbCBtYWtlIHRoZSB3YWxrZXIgdW5hYmxlXG4gIC8vIHRvIGdvIHBhc3QgaXQuXG4gIHZhciBjYWxsZXIgPSBhcmd1bWVudHMuY2FsbGVlO1xuICB2YXIgZnVuY3Rpb25zID0gW2dldEVycm9yV2l0aFN0YWNrXTtcbiAgZm9yICh2YXIgaT0wOyBjYWxsZXIgJiYgaSA8IDEwOyBpKyspIHtcbiAgICBmdW5jdGlvbnMucHVzaChjYWxsZXIpO1xuICAgIGlmIChjYWxsZXIuY2FsbGVyID09PSBjYWxsZXIpIGJyZWFrO1xuICAgIGNhbGxlciA9IGNhbGxlci5jYWxsZXI7XG4gIH1cbiAgY2FsbGVyID0gbnVsbDtcblxuICByZXR1cm4gZnVuY3Rpb24gKGNsZWFudXApIHtcbiAgICB2YXIgZnJhbWVzID0gbnVsbDtcblxuICAgIGlmICghY2xlYW51cCkge1xuICAgICAgLy8gUGFyc2UgdGhlIHN0YWNrIHRyYWNlXG4gICAgICBmcmFtZXMgPSBFcnJvclN0YWNrUGFyc2VyLnBhcnNlKGVycm9yKTtcbiAgICAgIC8vIEF0dGFjaCBmdW5jdGlvbiByZWZlcmVuY2VzIHRvIHRoZSBmcmFtZXMgKHNraXBwaW5nIHRoZSBtYWtlciBmcmFtZXMpXG4gICAgICAvLyBhbmQgY3JlYXRpbmcgQ2FsbFNpdGUgb2JqZWN0cyBmb3IgZWFjaCBvbmUuXG4gICAgICBmb3IgKHZhciBpPTI7IGkgPCBmcmFtZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgZnJhbWVzW2ldLmZ1bmN0aW9uID0gZnVuY3Rpb25zW2ldO1xuICAgICAgICBmcmFtZXNbaV0gPSBuZXcgQ2FsbFNpdGUoZnJhbWVzW2ldKTtcbiAgICAgIH1cblxuICAgICAgZnJhbWVzID0gdHJpbShmcmFtZXMuc2xpY2UoMiksIHNmZik7XG4gICAgfVxuXG4gICAgLy8gQ2xlYW4gdXAgY2xvc3VyZSB2YXJpYWJsZXMgdG8gaGVscCBHQ1xuICAgIHNmZiA9IG51bGw7XG4gICAgZXJyb3IgPSBudWxsO1xuICAgIGZ1bmN0aW9ucyA9IG51bGw7XG5cbiAgICByZXR1cm4gZnJhbWVzO1xuICB9O1xufVxuXG4vLyBHZW5lcmF0ZXMgYSBnZXR0ZXIgZm9yIHRoZSBjYWxsIHNpdGUgZnJhbWVzXG4vLyBUT0RPOiBJZiB3ZSBvYnNlcnZlIGxlYWtzIHdpdGggY29tcGxleCB1c2UgY2FzZXMgKGR1ZSB0byBjbG9zdXJlIHNjb3Blcylcbi8vICAgICAgIHdlIGNhbiBnZW5lcmF0ZSBoZXJlIG91ciBjb21wYXQgQ2FsbFNpdGUgb2JqZWN0cyBzdG9yaW5nIHRoZSBmdW5jdGlvbidzXG4vLyAgICAgICBzb3VyY2UgY29kZSBpbnN0ZWFkIG9mIGFuIGFjdHVhbCByZWZlcmVuY2UgdG8gdGhlbSwgdGhhdCBzaG91bGQgaGVscFxuLy8gICAgICAgdGhlIEdDIHNpbmNlIHdlJ2xsIGJlIGp1c3Qga2VlcGluZyBsaXRlcmFscyBhcm91bmQuXG52YXIgbWFrZUZyYW1lc0dldHRlciA9IHR5cGVvZiBOYXRpdmVFcnJvci5jYXB0dXJlU3RhY2tUcmFjZSA9PT0gJ2Z1bmN0aW9uJ1xuICAgICAgICAgICAgICAgICAgICAgPyBtYWtlRnJhbWVzR2V0dGVyVjhcbiAgICAgICAgICAgICAgICAgICAgIDogbWFrZUZyYW1lc0dldHRlckNvbXBhdDtcblxuXG4vLyBPdmVycmlkZSBWOCBzdGFjayB0cmFjZSBidWlsZGVyIHRvIGluamVjdCBvdXIgbG9naWNcbnZhciBvbGRQcmVwYXJlU3RhY2tUcmFjZSA9IEVycm9yLnByZXBhcmVTdGFja1RyYWNlO1xuRXJyb3IucHJlcGFyZVN0YWNrVHJhY2UgPSBmdW5jdGlvbiAoZXJyb3IsIGZyYW1lcykge1xuICAvLyBXaGVuIGNhbGxlZCBmcm9tIG1ha2VGcmFtZXNHZXR0ZXIgd2UganVzdCB3YW50IHRvIG9idGFpbiB0aGUgZnJhbWVzXG4gIGlmIChlcnJvciA9PT0gVjhGUkFNRVMpIHtcbiAgICByZXR1cm4gZnJhbWVzO1xuICB9XG5cbiAgLy8gRm9yd2FyZCB0byBhbnkgcHJldmlvdXNseSBkZWZpbmVkIGJlaGF2aW91clxuICBpZiAob2xkUHJlcGFyZVN0YWNrVHJhY2UpIHtcbiAgICByZXR1cm4gb2xkUHJlcGFyZVN0YWNrVHJhY2UuY2FsbChFcnJvciwgZXJyb3IsIGZyYW1lcyk7XG4gIH1cblxuICAvLyBFbXVsYXRlIGRlZmF1bHQgYmVoYXZpb3VyICh3aXRoIGxvbmctdHJhY2VzKVxuICByZXR1cm4gRmFpbHVyZS5wcm90b3R5cGUucHJlcGFyZVN0YWNrVHJhY2UuY2FsbChlcnJvciwgdW53aW5kKGZyYW1lcykpO1xufTtcblxuLy8gQXR0YWNoIGEgbmV3IGV4Y2x1c2lvbiBwcmVkaWNhdGUgZm9yIGZyYW1lc1xuZnVuY3Rpb24gZXhjbHVkZSAoY3RvciwgcHJlZGljYXRlKSB7XG4gIHZhciBmbiA9IHByZWRpY2F0ZTtcblxuICBpZiAodHlwZW9mIHByZWRpY2F0ZSA9PT0gJ3N0cmluZycpIHtcbiAgICBmbiA9IGZ1bmN0aW9uIChmcmFtZSkge1xuICAgICAgcmV0dXJuIC0xICE9PSBmcmFtZS5nZXRGaWxlTmFtZSgpLmluZGV4T2YocHJlZGljYXRlKTtcbiAgICB9O1xuICB9IGVsc2UgaWYgKHR5cGVvZiBwcmVkaWNhdGUudGVzdCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIGZuID0gZnVuY3Rpb24gKGZyYW1lKSB7XG4gICAgICByZXR1cm4gcHJlZGljYXRlLnRlc3QoZnJhbWUuZ2V0RmlsZU5hbWUoKSk7XG4gICAgfTtcbiAgfVxuXG4gIGN0b3IuZXhjbHVkZXMucHVzaChmbik7XG59XG5cbi8vIEV4cG9zZSB0aGUgZmlsdGVyIGluIHRoZSByb290IEZhaWx1cmUgdHlwZVxuRmFpbHVyZS5leGNsdWRlcyA9IFtdO1xuRmFpbHVyZS5leGNsdWRlID0gZnVuY3Rpb24gRmFpbHVyZV9leGNsdWRlIChwcmVkaWNhdGUpIHtcbiAgZXhjbHVkZShGYWlsdXJlLCBwcmVkaWNhdGUpO1xufTtcblxuLy8gQXR0YWNoIGEgZnJhbWVzIGdldHRlciB0byB0aGUgZnVuY3Rpb24gc28gd2UgY2FuIHJlLWNvbnN0cnVjdCBhc3luYyBzdGFja3MuXG4vL1xuLy8gTm90ZSB0aGF0IHRoaXMganVzdCBhdWdtZW50cyB0aGUgZnVuY3Rpb24gd2l0aCB0aGUgbmV3IHByb3BlcnR5LCBpdCBkb2Vzbid0XG4vLyBjcmVhdGUgYSB3cmFwcGVyIGV2ZXJ5IHRpbWUgaXQncyBjYWxsZWQsIHNvIHVzaW5nIGl0IG11bHRpcGxlIHRpbWVzIG9uIHRoZVxuLy8gc2FtZSBmdW5jdGlvbiB3aWxsIGluZGVlZCBvdmVyd3JpdGUgdGhlIHByZXZpb3VzIHRyYWNraW5nIGluZm9ybWF0aW9uLiBUaGlzXG4vLyBpcyBpbnRlbmRlZCBzaW5jZSBpdCdzIGZhc3RlciBhbmQgbW9yZSBpbXBvcnRhbnRseSBkb2Vzbid0IGJyZWFrIHNvbWUgQVBJc1xuLy8gdXNpbmcgY2FsbGJhY2sgcmVmZXJlbmNlcyB0byB1bnJlZ2lzdGVyIHRoZW0gZm9yIGluc3RhbmNlLlxuLy8gV2hlbiB5b3Ugd2FudCB0byB1c2UgdGhlIHNhbWUgZnVuY3Rpb24gd2l0aCBkaWZmZXJlbnQgdHJhY2tpbmcgaW5mb3JtYXRpb25cbi8vIGp1c3QgdXNlIEZhaWx1cmUud3JhcCgpLlxuLy9cbi8vIFRoZSB0cmFja2luZyBjYW4gYmUgZ2xvYmFsbHkgZGlzYWJsZWQgYnkgc2V0dGluZyBGYWlsdXJlLlRSQUNLIHRvIGZhbHNlXG5GYWlsdXJlLnRyYWNrID0gZnVuY3Rpb24gRmFpbHVyZV90cmFjayAoZm4sIHNmZikge1xuICBpZiAodHlwZW9mIGZuICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgcmV0dXJuIGZuO1xuICB9XG5cbiAgLy8gQ2xlYW4gdXAgcHJldmlvdXMgZnJhbWVzIHRvIGhlbHAgdGhlIEdDXG4gIGlmICh0eXBlb2YgZm5bU1lNQk9MX0ZSQU1FU10gPT09ICdmdW5jdGlvbicpIHtcbiAgICBmbltTWU1CT0xfRlJBTUVTXSh0cnVlKTtcbiAgfVxuXG4gIGlmIChGYWlsdXJlLlRSQUNLKSB7XG4gICAgZm5bU1lNQk9MX0ZSQU1FU10gPSBudWxsO1xuICAgIGZuW1NZTUJPTF9GUkFNRVNdID0gbWFrZUZyYW1lc0dldHRlcihzZmYgfHwgRmFpbHVyZV90cmFjayk7XG4gIH1cblxuICByZXR1cm4gZm47XG59O1xuXG4vLyBXcmFwcyB0aGUgZnVuY3Rpb24gYmVmb3JlIGFubm90YXRpbmcgaXQgd2l0aCB0cmFja2luZyBpbmZvcm1hdGlvbiwgdGhpc1xuLy8gYWxsb3dzIHRvIHRyYWNrIG11bHRpcGxlIHNjaGVkdWxsaW5ncyBvZiBhIHNpbmdsZSBmdW5jdGlvbi5cbkZhaWx1cmUud3JhcCA9IGZ1bmN0aW9uIEZhaWx1cmVfd3JhcCAoZm4pIHtcbiAgdmFyIHdyYXBwZXIgPSBGYWlsdXJlLmlnbm9yZShmdW5jdGlvbiAoKSB7XG4gICAgcmV0dXJuIGZuLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gIH0pO1xuXG4gIHJldHVybiBGYWlsdXJlLnRyYWNrKHdyYXBwZXIsIEZhaWx1cmVfd3JhcCk7XG59O1xuXG4vLyBNYXJrIGEgZnVuY3Rpb24gdG8gYmUgaWdub3JlZCB3aGVuIGdlbmVyYXRpbmcgc3RhY2sgdHJhY2VzXG5GYWlsdXJlLmlnbm9yZSA9IGZ1bmN0aW9uIEZhaWx1cmVfaWdub3JlIChmbikge1xuICBmbltTWU1CT0xfSUdOT1JFXSA9IHRydWU7XG4gIHJldHVybiBmbjtcbn07XG5cbkZhaWx1cmUuc2V0VGltZW91dCA9IGZ1bmN0aW9uIEZhaWx1cmVfc2V0VGltZW91dCAoKSB7XG4gIGFyZ3VtZW50c1swXSA9IEZhaWx1cmUudHJhY2soYXJndW1lbnRzWzBdLCBGYWlsdXJlX3NldFRpbWVvdXQpO1xuICByZXR1cm4gc2V0VGltZW91dC5hcHBseShudWxsLCBhcmd1bWVudHMpO1xufTtcblxuRmFpbHVyZS5uZXh0VGljayA9IGZ1bmN0aW9uIEZhaWx1cmVfbmV4dFRpY2sgKCkge1xuICBhcmd1bWVudHNbMF0gPSBGYWlsdXJlLnRyYWNrKGFyZ3VtZW50c1swXSwgRmFpbHVyZV9uZXh0VGljayk7XG4gIHJldHVybiBwcm9jZXNzLm5leHRUaWNrLmFwcGx5KHByb2Nlc3MsIGFyZ3VtZW50cyk7XG59O1xuXG5GYWlsdXJlLnBhdGNoID0gZnVuY3Rpb24gRmFpbHVyZV9wYXRjaChvYmosIG5hbWUsIGlkeCkge1xuICBpZiAob2JqICYmIHR5cGVvZiBvYmpbbmFtZV0gIT09ICdmdW5jdGlvbicpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ09iamVjdCBkb2VzIG5vdCBoYXZlIGEgXCInICsgbmFtZSArICdcIiBtZXRob2QnKTtcbiAgfVxuXG4gIHZhciBvcmlnaW5hbCA9IG9ialtuYW1lXTtcblxuICAvLyBXaGVuIHRoZSBleGFjdCBhcmd1bWVudCBpbmRleCBpcyBwcm92aWRlZCB1c2UgYW4gb3B0aW1pemVkIGNvZGUgcGF0aFxuICBpZiAodHlwZW9mIGlkeCA9PT0gJ251bWJlcicpIHtcblxuICAgIG9ialtuYW1lXSA9IGZ1bmN0aW9uICgpIHtcbiAgICAgIGFyZ3VtZW50c1tpZHhdID0gRmFpbHVyZS50cmFjayhhcmd1bWVudHNbaWR4XSwgb2JqW25hbWVdKTtcbiAgICAgIHJldHVybiBvcmlnaW5hbC5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xuICAgIH07XG5cbiAgLy8gT3RoZXJ3aXNlIGRldGVjdCB0aGUgZnVuY3Rpb25zIHRvIHRyYWNrIGF0IGludm9rYXRpb24gdGltZVxuICB9IGVsc2Uge1xuXG4gICAgb2JqW25hbWVdID0gZnVuY3Rpb24gKCkge1xuICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBhcmd1bWVudHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgaWYgKHR5cGVvZiBhcmd1bWVudHNbaV0gPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICBhcmd1bWVudHNbaV0gPSBGYWlsdXJlLnRyYWNrKGFyZ3VtZW50c1tpXSwgb2JqW25hbWVdKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuIG9yaWdpbmFsLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gICAgfTtcblxuICB9XG5cbiAgLy8gQXVnbWVudCB0aGUgd3JhcHBlciB3aXRoIGFueSBwcm9wZXJ0aWVzIGZyb20gdGhlIG9yaWdpbmFsXG4gIGZvciAodmFyIGsgaW4gb3JpZ2luYWwpIGlmIChvcmlnaW5hbC5oYXNPd25Qcm9wZXJ0eShrKSkge1xuICAgIG9ialtuYW1lXVtrXSA9IG9yaWdpbmFsW2tdO1xuICB9XG5cbiAgcmV0dXJuIG9ialtuYW1lXTtcbn07XG5cbi8vIEhlbHBlciB0byBjcmVhdGUgbmV3IEZhaWx1cmUgdHlwZXNcbkZhaWx1cmUuY3JlYXRlID0gZnVuY3Rpb24gKG5hbWUsIHByb3BzKSB7XG4gIGlmICh0eXBlb2YgbmFtZSAhPT0gJ3N0cmluZycpIHtcbiAgICB0aHJvdyBuZXcgRmFpbHVyZSgnRXhwZWN0ZWQgYSBuYW1lIGFzIGZpcnN0IGFyZ3VtZW50Jyk7XG4gIH1cblxuICBmdW5jdGlvbiBjdG9yIChtZXNzYWdlLCBzZmYpIHtcbiAgICBpZiAoISh0aGlzIGluc3RhbmNlb2YgRmFpbHVyZSkpIHtcbiAgICAgIHJldHVybiBuZXcgY3RvcihtZXNzYWdlLCBzZmYpO1xuICAgIH1cbiAgICBGYWlsdXJlLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gIH1cblxuICAvLyBBdWdtZW50IGNvbnN0cnVjdG9yXG4gIGN0b3IuZXhjbHVkZXMgPSBbXTtcbiAgY3Rvci5leGNsdWRlID0gZnVuY3Rpb24gKHByZWRpY2F0ZSkge1xuICAgIGV4Y2x1ZGUoY3RvciwgcHJlZGljYXRlKTtcbiAgfTtcblxuICBjdG9yLnByb3RvdHlwZSA9IE9iamVjdC5jcmVhdGUoRmFpbHVyZS5wcm90b3R5cGUpO1xuICBjdG9yLnByb3RvdHlwZS5jb25zdHJ1Y3RvciA9IGN0b3I7XG4gIGN0b3IucHJvdG90eXBlLm5hbWUgPSBuYW1lO1xuICBpZiAodHlwZW9mIHByb3BzID09PSAnZnVuY3Rpb24nKSB7XG4gICAgY3Rvci5wcm90b3R5cGUucHJlcGFyZVN0YWNrVHJhY2UgPSBwcm9wcztcbiAgfSBlbHNlIGlmIChwcm9wcykge1xuICAgIE9iamVjdC5rZXlzKHByb3BzKS5mb3JFYWNoKGZ1bmN0aW9uIChwcm9wKSB7XG4gICAgICBjdG9yLnByb3RvdHlwZVtwcm9wXSA9IHByb3A7XG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIGN0b3I7XG59O1xuXG52YXIgYnVpbHRpbkVycm9yVHlwZXMgPSBbXG4gICdFcnJvcicsICdUeXBlRXJyb3InLCAnUmFuZ2VFcnJvcicsICdSZWZlcmVuY2VFcnJvcicsICdTeW50YXhFcnJvcicsXG4gICdFdmFsRXJyb3InLCAnVVJJRXJyb3InLCAnSW50ZXJuYWxFcnJvcidcbl07XG52YXIgYnVpbHRpbkVycm9ycyA9IHt9O1xuXG5GYWlsdXJlLmluc3RhbGwgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciByb290ID0gdHlwZW9mIHdpbmRvdyA9PT0gJ29iamVjdCcgPyB3aW5kb3cgOiBnbG9iYWw7XG5cbiAgYnVpbHRpbkVycm9yVHlwZXMuZm9yRWFjaChmdW5jdGlvbiAodHlwZSkge1xuICAgIGlmIChyb290W3R5cGVdICYmICFidWlsdGluRXJyb3JzW3R5cGVdKSB7XG4gICAgICBidWlsdGluRXJyb3JzW3R5cGVdID0gcm9vdFt0eXBlXTtcbiAgICAgIHJvb3RbdHlwZV0gPSBGYWlsdXJlLmNyZWF0ZSh0eXBlKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIEFsbG93IHVzYWdlOiB2YXIgRmFpbHVyZSA9IHJlcXVpcmUoJ2ZhaWx1cmUnKS5pbnN0YWxsKClcbiAgcmV0dXJuIEZhaWx1cmU7XG59O1xuXG5GYWlsdXJlLnVuaW5zdGFsbCA9IGZ1bmN0aW9uICgpIHtcbiAgYnVpbHRpbkVycm9yVHlwZXMuZm9yRWFjaChmdW5jdGlvbiAodHlwZSkge1xuICAgIHJvb3RbdHlwZV0gPSBidWlsdGluRXJyb3JzW3R5cGVdIHx8IHJvb3RbdHlwZV07XG4gIH0pO1xufTtcblxuXG52YXIgcHJvdG8gPSBGYWlsdXJlLnByb3RvdHlwZSA9IE9iamVjdC5jcmVhdGUoRXJyb3IucHJvdG90eXBlKTtcbnByb3RvLmNvbnN0cnVjdG9yID0gRmFpbHVyZTtcblxucHJvdG8ubmFtZSA9ICdGYWlsdXJlJztcbnByb3RvLm1lc3NhZ2UgPSAnJztcblxuaWYgKHR5cGVvZiBPYmplY3QuZGVmaW5lUHJvcGVydHkgPT09ICdmdW5jdGlvbicpIHtcbiAgT2JqZWN0LmRlZmluZVByb3BlcnR5KHByb3RvLCAnZnJhbWVzJywge1xuICAgIGdldDogZnVuY3Rpb24gKCkge1xuICAgICAgLy8gVXNlIHRyaW1taW5nIGp1c3QgaW4gY2FzZSB0aGUgc2ZmIHdhcyBkZWZpbmVkIGFmdGVyIGNvbnN0cnVjdGluZ1xuICAgICAgdmFyIGZyYW1lcyA9IHVud2luZCh0cmltKHRoaXMuX2dldEZyYW1lcygpLCB0aGlzLnNmZikpO1xuXG4gICAgICAvLyBDYWNoZSBuZXh0IGFjY2Vzc2VzIHRvIHRoZSBwcm9wZXJ0eVxuICAgICAgT2JqZWN0LmRlZmluZVByb3BlcnR5KHRoaXMsICdmcmFtZXMnLCB7XG4gICAgICAgIHZhbHVlOiBmcmFtZXMsXG4gICAgICAgIHdyaXRhYmxlOiB0cnVlXG4gICAgICB9KTtcblxuICAgICAgLy8gQ2xlYW4gdXAgdGhlIGdldHRlciBjbG9zdXJlXG4gICAgICB0aGlzLl9nZXRGcmFtZXMgPSBudWxsO1xuXG4gICAgICByZXR1cm4gZnJhbWVzO1xuICAgIH1cbiAgfSk7XG5cbiAgT2JqZWN0LmRlZmluZVByb3BlcnR5KHByb3RvLCAnc3RhY2snLCB7XG4gICAgZ2V0OiBmdW5jdGlvbiAoKSB7XG4gICAgICByZXR1cm4gdGhpcy5nZW5lcmF0ZVN0YWNrVHJhY2UoKTtcbiAgICB9XG4gIH0pO1xufVxuXG5wcm90by5nZW5lcmF0ZVN0YWNrVHJhY2UgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBleGNsdWRlcyA9IHRoaXMuY29uc3RydWN0b3IuZXhjbHVkZXM7XG4gIHZhciBpbmNsdWRlLCBmcmFtZXMgPSBbXTtcblxuICAvLyBTcGVjaWZpYyBwcm90b3R5cGVzIGluaGVyaXQgdGhlIGV4Y2x1ZGVzIGZyb20gRmFpbHVyZVxuICBpZiAoZXhjbHVkZXMgIT09IEZhaWx1cmUuZXhjbHVkZXMpIHtcbiAgICBleGNsdWRlcy5wdXNoLmFwcGx5KGV4Y2x1ZGVzLCBGYWlsdXJlLmV4Y2x1ZGVzKTtcbiAgfVxuXG4gIC8vIEFwcGx5IGZpbHRlcmluZ1xuICBmb3IgKHZhciBpPTA7IGkgPCB0aGlzLmZyYW1lcy5sZW5ndGg7IGkrKykge1xuICAgIGluY2x1ZGUgPSB0cnVlO1xuICAgIGlmICh0aGlzLmZyYW1lc1tpXSkge1xuICAgICAgZm9yICh2YXIgaj0wOyBpbmNsdWRlICYmIGogPCBleGNsdWRlcy5sZW5ndGg7IGorKykge1xuICAgICAgICBpbmNsdWRlICY9ICFleGNsdWRlc1tqXS5jYWxsKHRoaXMsIHRoaXMuZnJhbWVzW2ldKTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKGluY2x1ZGUpIHtcbiAgICAgIGZyYW1lcy5wdXNoKHRoaXMuZnJhbWVzW2ldKTtcbiAgICB9XG4gIH1cblxuICAvLyBIb25vciBhbnkgcHJldmlvdXNseSBkZWZpbmVkIHN0YWNrdHJhY2UgZm9ybWF0dGVyIGJ5XG4gIC8vIGFsbG93aW5nIGl0IGZpbmFsbHkgZm9ybWF0IHRoZSBmcmFtZXMuIFRoaXMgaXMgbmVlZGVkXG4gIC8vIHdoZW4gdXNpbmcgbm9kZS1zb3VyY2UtbWFwLXN1cHBvcnQgZm9yIGluc3RhbmNlLlxuICAvLyBUT0RPOiBDYW4gd2UgbWFwIHRoZSBcIm51bGxcIiBmcmFtZXMgdG8gYSBDYWxsRnJhbWUgc2hpbT9cbiAgaWYgKG9sZFByZXBhcmVTdGFja1RyYWNlKSB7XG4gICAgZnJhbWVzID0gZnJhbWVzLmZpbHRlcihmdW5jdGlvbiAoeCkgeyByZXR1cm4gISF4OyB9KTtcbiAgICByZXR1cm4gb2xkUHJlcGFyZVN0YWNrVHJhY2UuY2FsbChFcnJvciwgdGhpcywgZnJhbWVzKTtcbiAgfVxuXG4gIHJldHVybiB0aGlzLnByZXBhcmVTdGFja1RyYWNlKGZyYW1lcyk7XG59O1xuXG5wcm90by5wcmVwYXJlU3RhY2tUcmFjZSA9IGZ1bmN0aW9uIChmcmFtZXMpIHtcbiAgdmFyIGxpbmVzID0gW3RoaXNdO1xuICBmb3IgKHZhciBpPTA7IGkgPCBmcmFtZXMubGVuZ3RoOyBpKyspIHtcbiAgICBsaW5lcy5wdXNoKFxuICAgICAgZnJhbWVzW2ldID8gRmFpbHVyZS5GUkFNRV9QUkVGSVggKyBmcmFtZXNbaV0gOiBGYWlsdXJlLkZSQU1FX0VNUFRZXG4gICAgKTtcbiAgfVxuICByZXR1cm4gbGluZXMuam9pbignXFxuJyk7XG59O1xuXG5cbm1vZHVsZS5leHBvcnRzID0gRmFpbHVyZTtcbiIsInZhciBGYWlsdXJlID0gcmVxdWlyZSgnLi9saWIvZmFpbHVyZScpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IEZhaWx1cmU7XG4iLCIvLyBzaGltIGZvciB1c2luZyBwcm9jZXNzIGluIGJyb3dzZXJcblxudmFyIHByb2Nlc3MgPSBtb2R1bGUuZXhwb3J0cyA9IHt9O1xuXG5wcm9jZXNzLm5leHRUaWNrID0gKGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgY2FuU2V0SW1tZWRpYXRlID0gdHlwZW9mIHdpbmRvdyAhPT0gJ3VuZGVmaW5lZCdcbiAgICAmJiB3aW5kb3cuc2V0SW1tZWRpYXRlO1xuICAgIHZhciBjYW5NdXRhdGlvbk9ic2VydmVyID0gdHlwZW9mIHdpbmRvdyAhPT0gJ3VuZGVmaW5lZCdcbiAgICAmJiB3aW5kb3cuTXV0YXRpb25PYnNlcnZlcjtcbiAgICB2YXIgY2FuUG9zdCA9IHR5cGVvZiB3aW5kb3cgIT09ICd1bmRlZmluZWQnXG4gICAgJiYgd2luZG93LnBvc3RNZXNzYWdlICYmIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyXG4gICAgO1xuXG4gICAgaWYgKGNhblNldEltbWVkaWF0ZSkge1xuICAgICAgICByZXR1cm4gZnVuY3Rpb24gKGYpIHsgcmV0dXJuIHdpbmRvdy5zZXRJbW1lZGlhdGUoZikgfTtcbiAgICB9XG5cbiAgICB2YXIgcXVldWUgPSBbXTtcblxuICAgIGlmIChjYW5NdXRhdGlvbk9ic2VydmVyKSB7XG4gICAgICAgIHZhciBoaWRkZW5EaXYgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgICB2YXIgb2JzZXJ2ZXIgPSBuZXcgTXV0YXRpb25PYnNlcnZlcihmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICB2YXIgcXVldWVMaXN0ID0gcXVldWUuc2xpY2UoKTtcbiAgICAgICAgICAgIHF1ZXVlLmxlbmd0aCA9IDA7XG4gICAgICAgICAgICBxdWV1ZUxpc3QuZm9yRWFjaChmdW5jdGlvbiAoZm4pIHtcbiAgICAgICAgICAgICAgICBmbigpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIG9ic2VydmVyLm9ic2VydmUoaGlkZGVuRGl2LCB7IGF0dHJpYnV0ZXM6IHRydWUgfSk7XG5cbiAgICAgICAgcmV0dXJuIGZ1bmN0aW9uIG5leHRUaWNrKGZuKSB7XG4gICAgICAgICAgICBpZiAoIXF1ZXVlLmxlbmd0aCkge1xuICAgICAgICAgICAgICAgIGhpZGRlbkRpdi5zZXRBdHRyaWJ1dGUoJ3llcycsICdubycpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcXVldWUucHVzaChmbik7XG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgaWYgKGNhblBvc3QpIHtcbiAgICAgICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ21lc3NhZ2UnLCBmdW5jdGlvbiAoZXYpIHtcbiAgICAgICAgICAgIHZhciBzb3VyY2UgPSBldi5zb3VyY2U7XG4gICAgICAgICAgICBpZiAoKHNvdXJjZSA9PT0gd2luZG93IHx8IHNvdXJjZSA9PT0gbnVsbCkgJiYgZXYuZGF0YSA9PT0gJ3Byb2Nlc3MtdGljaycpIHtcbiAgICAgICAgICAgICAgICBldi5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICAgICAgICAgICAgICBpZiAocXVldWUubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgICAgICB2YXIgZm4gPSBxdWV1ZS5zaGlmdCgpO1xuICAgICAgICAgICAgICAgICAgICBmbigpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSwgdHJ1ZSk7XG5cbiAgICAgICAgcmV0dXJuIGZ1bmN0aW9uIG5leHRUaWNrKGZuKSB7XG4gICAgICAgICAgICBxdWV1ZS5wdXNoKGZuKTtcbiAgICAgICAgICAgIHdpbmRvdy5wb3N0TWVzc2FnZSgncHJvY2Vzcy10aWNrJywgJyonKTtcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICByZXR1cm4gZnVuY3Rpb24gbmV4dFRpY2soZm4pIHtcbiAgICAgICAgc2V0VGltZW91dChmbiwgMCk7XG4gICAgfTtcbn0pKCk7XG5cbnByb2Nlc3MudGl0bGUgPSAnYnJvd3Nlcic7XG5wcm9jZXNzLmJyb3dzZXIgPSB0cnVlO1xucHJvY2Vzcy5lbnYgPSB7fTtcbnByb2Nlc3MuYXJndiA9IFtdO1xuXG5mdW5jdGlvbiBub29wKCkge31cblxucHJvY2Vzcy5vbiA9IG5vb3A7XG5wcm9jZXNzLmFkZExpc3RlbmVyID0gbm9vcDtcbnByb2Nlc3Mub25jZSA9IG5vb3A7XG5wcm9jZXNzLm9mZiA9IG5vb3A7XG5wcm9jZXNzLnJlbW92ZUxpc3RlbmVyID0gbm9vcDtcbnByb2Nlc3MucmVtb3ZlQWxsTGlzdGVuZXJzID0gbm9vcDtcbnByb2Nlc3MuZW1pdCA9IG5vb3A7XG5cbnByb2Nlc3MuYmluZGluZyA9IGZ1bmN0aW9uIChuYW1lKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdwcm9jZXNzLmJpbmRpbmcgaXMgbm90IHN1cHBvcnRlZCcpO1xufTtcblxuLy8gVE9ETyhzaHR5bG1hbilcbnByb2Nlc3MuY3dkID0gZnVuY3Rpb24gKCkgeyByZXR1cm4gJy8nIH07XG5wcm9jZXNzLmNoZGlyID0gZnVuY3Rpb24gKGRpcikge1xuICAgIHRocm93IG5ldyBFcnJvcigncHJvY2Vzcy5jaGRpciBpcyBub3Qgc3VwcG9ydGVkJyk7XG59O1xuIiwiKGZ1bmN0aW9uIChyb290LCBmYWN0b3J5KSB7XG4gICAgJ3VzZSBzdHJpY3QnO1xuICAgIC8vIFVuaXZlcnNhbCBNb2R1bGUgRGVmaW5pdGlvbiAoVU1EKSB0byBzdXBwb3J0IEFNRCwgQ29tbW9uSlMvTm9kZS5qcywgUmhpbm8sIGFuZCBicm93c2Vycy5cbiAgICBpZiAodHlwZW9mIGRlZmluZSA9PT0gJ2Z1bmN0aW9uJyAmJiBkZWZpbmUuYW1kKSB7XG4gICAgICAgIGRlZmluZSgnZXJyb3Itc3RhY2stcGFyc2VyJywgWydzdGFja2ZyYW1lJ10sIGZhY3RvcnkpO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIGV4cG9ydHMgPT09ICdvYmplY3QnKSB7XG4gICAgICAgIG1vZHVsZS5leHBvcnRzID0gZmFjdG9yeShyZXF1aXJlKCdzdGFja2ZyYW1lJykpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHJvb3QuRXJyb3JTdGFja1BhcnNlciA9IGZhY3Rvcnkocm9vdC5TdGFja0ZyYW1lKTtcbiAgICB9XG59KHRoaXMsIGZ1bmN0aW9uIEVycm9yU3RhY2tQYXJzZXIoU3RhY2tGcmFtZSkge1xuICAgICd1c2Ugc3RyaWN0JztcblxuICAgIC8vIEVTNSBQb2x5ZmlsbHNcbiAgICAvLyBTZWUgaHR0cHM6Ly9kZXZlbG9wZXIubW96aWxsYS5vcmcvZW4tVVMvZG9jcy9XZWIvSmF2YVNjcmlwdC9SZWZlcmVuY2UvR2xvYmFsX09iamVjdHMvQXJyYXkvbWFwXG4gICAgaWYgKCFBcnJheS5wcm90b3R5cGUubWFwKSB7XG4gICAgICAgIEFycmF5LnByb3RvdHlwZS5tYXAgPSBmdW5jdGlvbihjYWxsYmFjaywgdGhpc0FyZykge1xuICAgICAgICAgICAgdmFyIE8gPSBPYmplY3QodGhpcyk7XG4gICAgICAgICAgICB2YXIgbGVuID0gTy5sZW5ndGggPj4+IDA7XG4gICAgICAgICAgICB2YXIgVDtcbiAgICAgICAgICAgIGlmIChhcmd1bWVudHMubGVuZ3RoID4gMSkge1xuICAgICAgICAgICAgICAgIFQgPSB0aGlzQXJnO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB2YXIgQSA9IG5ldyBBcnJheShsZW4pO1xuICAgICAgICAgICAgdmFyIGsgPSAwO1xuXG4gICAgICAgICAgICB3aGlsZSAoayA8IGxlbikge1xuICAgICAgICAgICAgICAgIHZhciBrVmFsdWUsIG1hcHBlZFZhbHVlO1xuICAgICAgICAgICAgICAgIGlmIChrIGluIE8pIHtcbiAgICAgICAgICAgICAgICAgICAga1ZhbHVlID0gT1trXTtcbiAgICAgICAgICAgICAgICAgICAgbWFwcGVkVmFsdWUgPSBjYWxsYmFjay5jYWxsKFQsIGtWYWx1ZSwgaywgTyk7XG4gICAgICAgICAgICAgICAgICAgIEFba10gPSBtYXBwZWRWYWx1ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaysrO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gQTtcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBTZWUgaHR0cHM6Ly9kZXZlbG9wZXIubW96aWxsYS5vcmcvZW4tVVMvZG9jcy9XZWIvSmF2YVNjcmlwdC9SZWZlcmVuY2UvR2xvYmFsX09iamVjdHMvQXJyYXkvZmlsdGVyXG4gICAgaWYgKCFBcnJheS5wcm90b3R5cGUuZmlsdGVyKSB7XG4gICAgICAgIEFycmF5LnByb3RvdHlwZS5maWx0ZXIgPSBmdW5jdGlvbihjYWxsYmFjay8qLCB0aGlzQXJnKi8pIHtcbiAgICAgICAgICAgIHZhciB0ID0gT2JqZWN0KHRoaXMpO1xuICAgICAgICAgICAgdmFyIGxlbiA9IHQubGVuZ3RoID4+PiAwO1xuXG4gICAgICAgICAgICB2YXIgcmVzID0gW107XG4gICAgICAgICAgICB2YXIgdGhpc0FyZyA9IGFyZ3VtZW50cy5sZW5ndGggPj0gMiA/IGFyZ3VtZW50c1sxXSA6IHZvaWQgMDtcbiAgICAgICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbGVuOyBpKyspIHtcbiAgICAgICAgICAgICAgICBpZiAoaSBpbiB0KSB7XG4gICAgICAgICAgICAgICAgICAgIHZhciB2YWwgPSB0W2ldO1xuICAgICAgICAgICAgICAgICAgICBpZiAoY2FsbGJhY2suY2FsbCh0aGlzQXJnLCB2YWwsIGksIHQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXMucHVzaCh2YWwpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gcmVzO1xuICAgICAgICB9O1xuICAgIH1cblxuICAgIHZhciBGSVJFRk9YX1NBRkFSSV9TVEFDS19SRUdFWFAgPSAvXFxTK1xcOlxcZCsvO1xuICAgIHZhciBDSFJPTUVfSUVfU1RBQ0tfUkVHRVhQID0gL1xccythdCAvO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgICAgLyoqXG4gICAgICAgICAqIEdpdmVuIGFuIEVycm9yIG9iamVjdCwgZXh0cmFjdCB0aGUgbW9zdCBpbmZvcm1hdGlvbiBmcm9tIGl0LlxuICAgICAgICAgKiBAcGFyYW0gZXJyb3Ige0Vycm9yfVxuICAgICAgICAgKiBAcmV0dXJuIEFycmF5W1N0YWNrRnJhbWVdXG4gICAgICAgICAqL1xuICAgICAgICBwYXJzZTogZnVuY3Rpb24gRXJyb3JTdGFja1BhcnNlciQkcGFyc2UoZXJyb3IpIHtcbiAgICAgICAgICAgIGlmICh0eXBlb2YgZXJyb3Iuc3RhY2t0cmFjZSAhPT0gJ3VuZGVmaW5lZCcgfHwgdHlwZW9mIGVycm9yWydvcGVyYSNzb3VyY2Vsb2MnXSAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5wYXJzZU9wZXJhKGVycm9yKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoZXJyb3Iuc3RhY2sgJiYgZXJyb3Iuc3RhY2subWF0Y2goQ0hST01FX0lFX1NUQUNLX1JFR0VYUCkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5wYXJzZVY4T3JJRShlcnJvcik7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGVycm9yLnN0YWNrICYmIGVycm9yLnN0YWNrLm1hdGNoKEZJUkVGT1hfU0FGQVJJX1NUQUNLX1JFR0VYUCkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5wYXJzZUZGT3JTYWZhcmkoZXJyb3IpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCBwYXJzZSBnaXZlbiBFcnJvciBvYmplY3QnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuICAgICAgICAvKipcbiAgICAgICAgICogU2VwYXJhdGUgbGluZSBhbmQgY29sdW1uIG51bWJlcnMgZnJvbSBhIFVSTC1saWtlIHN0cmluZy5cbiAgICAgICAgICogQHBhcmFtIHVybExpa2UgU3RyaW5nXG4gICAgICAgICAqIEByZXR1cm4gQXJyYXlbU3RyaW5nXVxuICAgICAgICAgKi9cbiAgICAgICAgZXh0cmFjdExvY2F0aW9uOiBmdW5jdGlvbiBFcnJvclN0YWNrUGFyc2VyJCRleHRyYWN0TG9jYXRpb24odXJsTGlrZSkge1xuICAgICAgICAgICAgdmFyIGxvY2F0aW9uUGFydHMgPSB1cmxMaWtlLnNwbGl0KCc6Jyk7XG4gICAgICAgICAgICB2YXIgbGFzdE51bWJlciA9IGxvY2F0aW9uUGFydHMucG9wKCk7XG4gICAgICAgICAgICB2YXIgcG9zc2libGVOdW1iZXIgPSBsb2NhdGlvblBhcnRzW2xvY2F0aW9uUGFydHMubGVuZ3RoIC0gMV07XG4gICAgICAgICAgICBpZiAoIWlzTmFOKHBhcnNlRmxvYXQocG9zc2libGVOdW1iZXIpKSAmJiBpc0Zpbml0ZShwb3NzaWJsZU51bWJlcikpIHtcbiAgICAgICAgICAgICAgICB2YXIgbGluZU51bWJlciA9IGxvY2F0aW9uUGFydHMucG9wKCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFtsb2NhdGlvblBhcnRzLmpvaW4oJzonKSwgbGluZU51bWJlciwgbGFzdE51bWJlcl07XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJldHVybiBbbG9jYXRpb25QYXJ0cy5qb2luKCc6JyksIGxhc3ROdW1iZXIsIHVuZGVmaW5lZF07XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sXG5cbiAgICAgICAgcGFyc2VWOE9ySUU6IGZ1bmN0aW9uIEVycm9yU3RhY2tQYXJzZXIkJHBhcnNlVjhPcklFKGVycm9yKSB7XG4gICAgICAgICAgICByZXR1cm4gZXJyb3Iuc3RhY2suc3BsaXQoJ1xcbicpLnNsaWNlKDEpLm1hcChmdW5jdGlvbiAobGluZSkge1xuICAgICAgICAgICAgICAgIHZhciB0b2tlbnMgPSBsaW5lLnJlcGxhY2UoL15cXHMrLywgJycpLnNwbGl0KC9cXHMrLykuc2xpY2UoMSk7XG4gICAgICAgICAgICAgICAgdmFyIGxvY2F0aW9uUGFydHMgPSB0aGlzLmV4dHJhY3RMb2NhdGlvbih0b2tlbnMucG9wKCkucmVwbGFjZSgvW1xcKFxcKVxcc10vZywgJycpKTtcbiAgICAgICAgICAgICAgICB2YXIgZnVuY3Rpb25OYW1lID0gKCF0b2tlbnNbMF0gfHwgdG9rZW5zWzBdID09PSAnQW5vbnltb3VzJykgPyB1bmRlZmluZWQgOiB0b2tlbnNbMF07XG4gICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBTdGFja0ZyYW1lKGZ1bmN0aW9uTmFtZSwgdW5kZWZpbmVkLCBsb2NhdGlvblBhcnRzWzBdLCBsb2NhdGlvblBhcnRzWzFdLCBsb2NhdGlvblBhcnRzWzJdKTtcbiAgICAgICAgICAgIH0sIHRoaXMpO1xuICAgICAgICB9LFxuXG4gICAgICAgIHBhcnNlRkZPclNhZmFyaTogZnVuY3Rpb24gRXJyb3JTdGFja1BhcnNlciQkcGFyc2VGRk9yU2FmYXJpKGVycm9yKSB7XG4gICAgICAgICAgICByZXR1cm4gZXJyb3Iuc3RhY2suc3BsaXQoJ1xcbicpLmZpbHRlcihmdW5jdGlvbiAobGluZSkge1xuICAgICAgICAgICAgICAgIHJldHVybiAhIWxpbmUubWF0Y2goRklSRUZPWF9TQUZBUklfU1RBQ0tfUkVHRVhQKTtcbiAgICAgICAgICAgIH0sIHRoaXMpLm1hcChmdW5jdGlvbiAobGluZSkge1xuICAgICAgICAgICAgICAgIHZhciB0b2tlbnMgPSBsaW5lLnNwbGl0KCdAJyk7XG4gICAgICAgICAgICAgICAgdmFyIGxvY2F0aW9uUGFydHMgPSB0aGlzLmV4dHJhY3RMb2NhdGlvbih0b2tlbnMucG9wKCkpO1xuICAgICAgICAgICAgICAgIHZhciBmdW5jdGlvbk5hbWUgPSB0b2tlbnMuc2hpZnQoKSB8fCB1bmRlZmluZWQ7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBTdGFja0ZyYW1lKGZ1bmN0aW9uTmFtZSwgdW5kZWZpbmVkLCBsb2NhdGlvblBhcnRzWzBdLCBsb2NhdGlvblBhcnRzWzFdLCBsb2NhdGlvblBhcnRzWzJdKTtcbiAgICAgICAgICAgIH0sIHRoaXMpO1xuICAgICAgICB9LFxuXG4gICAgICAgIHBhcnNlT3BlcmE6IGZ1bmN0aW9uIEVycm9yU3RhY2tQYXJzZXIkJHBhcnNlT3BlcmEoZSkge1xuICAgICAgICAgICAgaWYgKCFlLnN0YWNrdHJhY2UgfHwgKGUubWVzc2FnZS5pbmRleE9mKCdcXG4nKSA+IC0xICYmXG4gICAgICAgICAgICAgICAgZS5tZXNzYWdlLnNwbGl0KCdcXG4nKS5sZW5ndGggPiBlLnN0YWNrdHJhY2Uuc3BsaXQoJ1xcbicpLmxlbmd0aCkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5wYXJzZU9wZXJhOShlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoIWUuc3RhY2spIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5wYXJzZU9wZXJhMTAoZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLnBhcnNlT3BlcmExMShlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuICAgICAgICBwYXJzZU9wZXJhOTogZnVuY3Rpb24gRXJyb3JTdGFja1BhcnNlciQkcGFyc2VPcGVyYTkoZSkge1xuICAgICAgICAgICAgdmFyIGxpbmVSRSA9IC9MaW5lIChcXGQrKS4qc2NyaXB0ICg/OmluICk/KFxcUyspL2k7XG4gICAgICAgICAgICB2YXIgbGluZXMgPSBlLm1lc3NhZ2Uuc3BsaXQoJ1xcbicpO1xuICAgICAgICAgICAgdmFyIHJlc3VsdCA9IFtdO1xuXG4gICAgICAgICAgICBmb3IgKHZhciBpID0gMiwgbGVuID0gbGluZXMubGVuZ3RoOyBpIDwgbGVuOyBpICs9IDIpIHtcbiAgICAgICAgICAgICAgICB2YXIgbWF0Y2ggPSBsaW5lUkUuZXhlYyhsaW5lc1tpXSk7XG4gICAgICAgICAgICAgICAgaWYgKG1hdGNoKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdC5wdXNoKG5ldyBTdGFja0ZyYW1lKHVuZGVmaW5lZCwgdW5kZWZpbmVkLCBtYXRjaFsyXSwgbWF0Y2hbMV0pKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0sXG5cbiAgICAgICAgcGFyc2VPcGVyYTEwOiBmdW5jdGlvbiBFcnJvclN0YWNrUGFyc2VyJCRwYXJzZU9wZXJhMTAoZSkge1xuICAgICAgICAgICAgdmFyIGxpbmVSRSA9IC9MaW5lIChcXGQrKS4qc2NyaXB0ICg/OmluICk/KFxcUyspKD86OiBJbiBmdW5jdGlvbiAoXFxTKykpPyQvaTtcbiAgICAgICAgICAgIHZhciBsaW5lcyA9IGUuc3RhY2t0cmFjZS5zcGxpdCgnXFxuJyk7XG4gICAgICAgICAgICB2YXIgcmVzdWx0ID0gW107XG5cbiAgICAgICAgICAgIGZvciAodmFyIGkgPSAwLCBsZW4gPSBsaW5lcy5sZW5ndGg7IGkgPCBsZW47IGkgKz0gMikge1xuICAgICAgICAgICAgICAgIHZhciBtYXRjaCA9IGxpbmVSRS5leGVjKGxpbmVzW2ldKTtcbiAgICAgICAgICAgICAgICBpZiAobWF0Y2gpIHtcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0LnB1c2gobmV3IFN0YWNrRnJhbWUobWF0Y2hbM10gfHwgdW5kZWZpbmVkLCB1bmRlZmluZWQsIG1hdGNoWzJdLCBtYXRjaFsxXSkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSxcblxuICAgICAgICAvLyBPcGVyYSAxMC42NSsgRXJyb3Iuc3RhY2sgdmVyeSBzaW1pbGFyIHRvIEZGL1NhZmFyaVxuICAgICAgICBwYXJzZU9wZXJhMTE6IGZ1bmN0aW9uIEVycm9yU3RhY2tQYXJzZXIkJHBhcnNlT3BlcmExMShlcnJvcikge1xuICAgICAgICAgICAgcmV0dXJuIGVycm9yLnN0YWNrLnNwbGl0KCdcXG4nKS5maWx0ZXIoZnVuY3Rpb24gKGxpbmUpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gISFsaW5lLm1hdGNoKEZJUkVGT1hfU0FGQVJJX1NUQUNLX1JFR0VYUCkgJiZcbiAgICAgICAgICAgICAgICAgICAgIWxpbmUubWF0Y2goL15FcnJvciBjcmVhdGVkIGF0Lyk7XG4gICAgICAgICAgICB9LCB0aGlzKS5tYXAoZnVuY3Rpb24gKGxpbmUpIHtcbiAgICAgICAgICAgICAgICB2YXIgdG9rZW5zID0gbGluZS5zcGxpdCgnQCcpO1xuICAgICAgICAgICAgICAgIHZhciBsb2NhdGlvblBhcnRzID0gdGhpcy5leHRyYWN0TG9jYXRpb24odG9rZW5zLnBvcCgpKTtcbiAgICAgICAgICAgICAgICB2YXIgZnVuY3Rpb25DYWxsID0gKHRva2Vucy5zaGlmdCgpIHx8ICcnKTtcbiAgICAgICAgICAgICAgICB2YXIgZnVuY3Rpb25OYW1lID0gZnVuY3Rpb25DYWxsXG4gICAgICAgICAgICAgICAgICAgICAgICAucmVwbGFjZSgvPGFub255bW91cyBmdW5jdGlvbig6IChcXHcrKSk/Pi8sICckMicpXG4gICAgICAgICAgICAgICAgICAgICAgICAucmVwbGFjZSgvXFwoW15cXCldKlxcKS9nLCAnJykgfHwgdW5kZWZpbmVkO1xuICAgICAgICAgICAgICAgIHZhciBhcmdzUmF3O1xuICAgICAgICAgICAgICAgIGlmIChmdW5jdGlvbkNhbGwubWF0Y2goL1xcKChbXlxcKV0qKVxcKS8pKSB7XG4gICAgICAgICAgICAgICAgICAgIGFyZ3NSYXcgPSBmdW5jdGlvbkNhbGwucmVwbGFjZSgvXlteXFwoXStcXCgoW15cXCldKilcXCkkLywgJyQxJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHZhciBhcmdzID0gKGFyZ3NSYXcgPT09IHVuZGVmaW5lZCB8fCBhcmdzUmF3ID09PSAnW2FyZ3VtZW50cyBub3QgYXZhaWxhYmxlXScpID8gdW5kZWZpbmVkIDogYXJnc1Jhdy5zcGxpdCgnLCcpO1xuICAgICAgICAgICAgICAgIHJldHVybiBuZXcgU3RhY2tGcmFtZShmdW5jdGlvbk5hbWUsIGFyZ3MsIGxvY2F0aW9uUGFydHNbMF0sIGxvY2F0aW9uUGFydHNbMV0sIGxvY2F0aW9uUGFydHNbMl0pO1xuICAgICAgICAgICAgfSwgdGhpcyk7XG4gICAgICAgIH1cbiAgICB9O1xufSkpO1xuXG4iLCIoZnVuY3Rpb24gKHJvb3QsIGZhY3RvcnkpIHtcbiAgICAndXNlIHN0cmljdCc7XG4gICAgLy8gVW5pdmVyc2FsIE1vZHVsZSBEZWZpbml0aW9uIChVTUQpIHRvIHN1cHBvcnQgQU1ELCBDb21tb25KUy9Ob2RlLmpzLCBSaGlubywgYW5kIGJyb3dzZXJzLlxuICAgIGlmICh0eXBlb2YgZGVmaW5lID09PSAnZnVuY3Rpb24nICYmIGRlZmluZS5hbWQpIHtcbiAgICAgICAgZGVmaW5lKFtdLCBmYWN0b3J5KTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBleHBvcnRzID09PSAnb2JqZWN0Jykge1xuICAgICAgICBtb2R1bGUuZXhwb3J0cyA9IGZhY3RvcnkoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICByb290LlN0YWNrRnJhbWUgPSBmYWN0b3J5KCk7XG4gICAgfVxufSh0aGlzLCBmdW5jdGlvbiAoKSB7XG4gICAgJ3VzZSBzdHJpY3QnO1xuICAgIGZ1bmN0aW9uIF9pc051bWJlcihuKSB7XG4gICAgICAgIHJldHVybiAhaXNOYU4ocGFyc2VGbG9hdChuKSkgJiYgaXNGaW5pdGUobik7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gU3RhY2tGcmFtZShmdW5jdGlvbk5hbWUsIGFyZ3MsIGZpbGVOYW1lLCBsaW5lTnVtYmVyLCBjb2x1bW5OdW1iZXIpIHtcbiAgICAgICAgaWYgKGZ1bmN0aW9uTmFtZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICB0aGlzLnNldEZ1bmN0aW9uTmFtZShmdW5jdGlvbk5hbWUpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChhcmdzICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgIHRoaXMuc2V0QXJncyhhcmdzKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoZmlsZU5hbWUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgdGhpcy5zZXRGaWxlTmFtZShmaWxlTmFtZSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGxpbmVOdW1iZXIgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgdGhpcy5zZXRMaW5lTnVtYmVyKGxpbmVOdW1iZXIpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChjb2x1bW5OdW1iZXIgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgdGhpcy5zZXRDb2x1bW5OdW1iZXIoY29sdW1uTnVtYmVyKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIFN0YWNrRnJhbWUucHJvdG90eXBlID0ge1xuICAgICAgICBnZXRGdW5jdGlvbk5hbWU6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmZ1bmN0aW9uTmFtZTtcbiAgICAgICAgfSxcbiAgICAgICAgc2V0RnVuY3Rpb25OYW1lOiBmdW5jdGlvbiAodikge1xuICAgICAgICAgICAgdGhpcy5mdW5jdGlvbk5hbWUgPSBTdHJpbmcodik7XG4gICAgICAgIH0sXG5cbiAgICAgICAgZ2V0QXJnczogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuYXJncztcbiAgICAgICAgfSxcbiAgICAgICAgc2V0QXJnczogZnVuY3Rpb24gKHYpIHtcbiAgICAgICAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwodikgIT09ICdbb2JqZWN0IEFycmF5XScpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdBcmdzIG11c3QgYmUgYW4gQXJyYXknKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRoaXMuYXJncyA9IHY7XG4gICAgICAgIH0sXG5cbiAgICAgICAgLy8gTk9URTogUHJvcGVydHkgbmFtZSBtYXkgYmUgbWlzbGVhZGluZyBhcyBpdCBpbmNsdWRlcyB0aGUgcGF0aCxcbiAgICAgICAgLy8gYnV0IGl0IHNvbWV3aGF0IG1pcnJvcnMgVjgncyBKYXZhU2NyaXB0U3RhY2tUcmFjZUFwaVxuICAgICAgICAvLyBodHRwczovL2NvZGUuZ29vZ2xlLmNvbS9wL3Y4L3dpa2kvSmF2YVNjcmlwdFN0YWNrVHJhY2VBcGlcbiAgICAgICAgZ2V0RmlsZU5hbWU6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmZpbGVOYW1lO1xuICAgICAgICB9LFxuICAgICAgICBzZXRGaWxlTmFtZTogZnVuY3Rpb24gKHYpIHtcbiAgICAgICAgICAgIHRoaXMuZmlsZU5hbWUgPSBTdHJpbmcodik7XG4gICAgICAgIH0sXG5cbiAgICAgICAgZ2V0TGluZU51bWJlcjogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMubGluZU51bWJlcjtcbiAgICAgICAgfSxcbiAgICAgICAgc2V0TGluZU51bWJlcjogZnVuY3Rpb24gKHYpIHtcbiAgICAgICAgICAgIGlmICghX2lzTnVtYmVyKHYpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignTGluZSBOdW1iZXIgbXVzdCBiZSBhIE51bWJlcicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhpcy5saW5lTnVtYmVyID0gTnVtYmVyKHYpO1xuICAgICAgICB9LFxuXG4gICAgICAgIGdldENvbHVtbk51bWJlcjogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuY29sdW1uTnVtYmVyO1xuICAgICAgICB9LFxuICAgICAgICBzZXRDb2x1bW5OdW1iZXI6IGZ1bmN0aW9uICh2KSB7XG4gICAgICAgICAgICBpZiAoIV9pc051bWJlcih2KSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ0NvbHVtbiBOdW1iZXIgbXVzdCBiZSBhIE51bWJlcicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhpcy5jb2x1bW5OdW1iZXIgPSBOdW1iZXIodik7XG4gICAgICAgIH0sXG5cbiAgICAgICAgdG9TdHJpbmc6IGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgdmFyIGZ1bmN0aW9uTmFtZSA9IHRoaXMuZ2V0RnVuY3Rpb25OYW1lKCkgfHwgJ3thbm9ueW1vdXN9JztcbiAgICAgICAgICAgIHZhciBhcmdzID0gJygnICsgKHRoaXMuZ2V0QXJncygpIHx8IFtdKS5qb2luKCcsJykgKyAnKSc7XG4gICAgICAgICAgICB2YXIgZmlsZU5hbWUgPSB0aGlzLmdldEZpbGVOYW1lKCkgPyAoJ0AnICsgdGhpcy5nZXRGaWxlTmFtZSgpKSA6ICcnO1xuICAgICAgICAgICAgdmFyIGxpbmVOdW1iZXIgPSBfaXNOdW1iZXIodGhpcy5nZXRMaW5lTnVtYmVyKCkpID8gKCc6JyArIHRoaXMuZ2V0TGluZU51bWJlcigpKSA6ICcnO1xuICAgICAgICAgICAgdmFyIGNvbHVtbk51bWJlciA9IF9pc051bWJlcih0aGlzLmdldENvbHVtbk51bWJlcigpKSA/ICgnOicgKyB0aGlzLmdldENvbHVtbk51bWJlcigpKSA6ICcnO1xuICAgICAgICAgICAgcmV0dXJuIGZ1bmN0aW9uTmFtZSArIGFyZ3MgKyBmaWxlTmFtZSArIGxpbmVOdW1iZXIgKyBjb2x1bW5OdW1iZXI7XG4gICAgICAgIH1cbiAgICB9O1xuXG4gICAgcmV0dXJuIFN0YWNrRnJhbWU7XG59KSk7XG4iXX0=
