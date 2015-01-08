var ErrorStackParser = require('error-stack-parser');
var CallSite = require('./call-site');


function Failure (message, sff) {
  if (!(this instanceof Failure)) {
    return new Failure(message, sff || Failure);
  }

  this.sff = sff || this.constructor;

  this.message = message;

  // Generate a getter for the frames, this ensures that we do as little work
  // as possible when instantiating the error, deferring the expensive stack
  // mangling operations until the .stack property is actually requested.
  var getFrames = makeFramesGetter(this.sff);

  // On ES5 engines we use one-time getters to actually defer the expensive
  // operations while legacy engines will simply do all the work up front.
  if (typeof Object.defineProperty === 'function') {

    Object.defineProperty(this, 'frames', {
      get: function () {
        var frames = getFrames();
        getFrames = null;  // Hopefully this helps with GC
        // Use trimming just in case the sff was defined after constructing
        return this.frames = trimFrames(frames, this.sff);
      },
      configurable: true
    });

    Object.defineProperty(this, 'stack', {
      get: function () {
        return this.stack = this.buildStackTrace();
      },
      configurable: true
    });

  } else {

    this.frames = getFrames();
    this.stack = this.buildStackTrace();

  }

  return this;
}

// Keep a reference to the builtin error constructor
Failure.Error = Error;

// Receiver for the frames in a .stack property from captureStackTrace
var V8FRAMES = {};

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

  // Emulate default behaviour
  var s = '' + error;
  frames.forEach(function (frame) {
    s += '\n at ' + frame;
  });
  return s;
};

// Helper to obtain the current stack trace
var getErrorWithStack = function () {
  return new Failure.Error;
};
// Some engines do not generate the .stack property until it's thrown
if (!getErrorWithStack().stack) {
  getErrorWithStack = function () {
    try { throw new Failure.Error } catch (e) { return e };
  };
}

// Trim frames under the provided stack first function
function trimFrames(frames, sff) {
  var name = sff.name;
  for (var i=0; i < frames.length; i++) {
    var fn = frames[i].getFunction();
    if (fn && fn === sff || name && name === frames[i].getFunctionName()) {
      return frames.slice(i + 1);
    }
  }
  return frames;
}

// Generates a getter for the call site frames
function makeFramesGetter (sff) {
  // V8 code path using its callsite API
  if (typeof Failure.Error.captureStackTrace === 'function') {
    Failure.Error.captureStackTrace(V8FRAMES, sff || makeFramesGetter);
    var frames = V8FRAMES.stack;
    return function () {
      return frames;
    };
  }

  // Obtain a stack trace at the current point
  var error = getErrorWithStack();

  // Walk the caller chain to annotate the stack with function references
  // Given the limitations imposed by ES5 "strict mode" it's not possible
  // to obtain references to functions beyond one that is defined in strict
  // mode.
  var caller = arguments.callee;
  var functions = [getErrorWithStack];
  for (var i=0; caller && i < 10; i++) {
    functions.push(caller);
    if (caller.caller === caller) break;
    caller = caller.caller;
  }

  return function () {
    // Parse the stack trace
    var frames = ErrorStackParser.parse(error);
    // Attach function references to the frames (skipping the maker frames)
    // and creating CallSite objects for each one.
    for (var i=2; i < frames.length; i++) {
      frames[i].function = functions[i];
      frames[i] = new CallSite(frames[i]);
    }
    return trimFrames(frames.slice(2), sff);
  };
}

// Attach a frames getter to the function so we can re-construct async stacks.
//
// Note that this just augments the function with the new property, it doesn't
// create a wrapper every time it's called, so using it multiple times on the
// same function will indeed overwrite the previous tracking information. This
// is intended since it's faster and more importantly doesn't break some APIs
// using callback references to unregister for instance.
// When you want to use the same function with different tracking information
// just use the standard .bind() without arguments.
//
// TODO: Make it toggable with a master setting so it can be enabled for dev only
Failure.track = function Failure_track (fn) {

  // Annotate the function with the frames getter
  fn.__frames__ = makeFramesGetter(Failure_track);

  return fn;
};

Failure.setTimeout = function Failure_setTimeout () {
  arguments[0] = Failure.track(arguments[0]);
  return setTimeout.apply(null, arguments);
};

Failure.nextTick = function Failure_nextTick () {
  arguments[0] = Failure.track(arguments[0]);
  return process.nextTick.apply(process, arguments);
};

Failure.patch = function (obj, name, idx) {
  if (obj && typeof obj[name] !== 'function') {
    throw new Error('Object does not have a "' + name + '" method');
  }
  idx = idx || 0;
  var original = obj[name];
  obj[name] = function () {
    arguments[idx] = Failure.track(arguments[idx]);
    return original.apply(this, arguments);
  };
};

// Helper to create new Failure types
Failure.create = function (name, props) {
  function ctor (message, sff) {
    if (!(this instanceof Failure)) {
      return new ctor(message, sff);
    }
    Failure.apply(this, arguments);
  }
  ctor.prototype = Object.create(Failure.prototype);
  ctor.prototype.constructor = ctor;
  ctor.prototype.name = name;
  if (props) {
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

proto.buildStackTrace = function () {
  console.log('.build');
  return this.prepareStackTrace(this.frames);
};


function unwind (frames) {
  var result = [];

  for (var i=0, fn; i < frames.length; i++) {
    result.push(frames[i]);

    fn = frames[i].getFunction();
    if (fn && fn.__frames__) {
      result.push(null);
      result.push.apply(result, unwind(fn.__frames__()));
      break;
    }
  }

  return result;
}

proto.prepareStackTrace = function (frames) {
  console.log('.prepare');

  // Filter out unrelated frames
  // TODO

  // Unwind frames
  frames = unwind(frames);

  // First frame is now the target
  var target = frames[0];

  // Filter out all frames which are not in the same file
  samefile = frames.filter(function (frame) {
    return frame && frame.getFileName() === target.getFileName();
  });

  // Get the closest function in the same file that wraps the target frame
  var wrapper;
  for (var i=1; i < samefile.length; i++) {
    var frame = samefile[i];
    if (frame.getLineNumber() > target.getLineNumber()) {
      continue;
    }
    if (!frame.getFunction()) {
      continue;
    }
    var lines = frame.getFunction().toString().split(/\n/);
    if (frame.getLineNumber() + lines.length < target.getLineNumber()) {
      continue;
    }
    wrapper = frame;
    break;
  }

  // When a wrapper function is found we can use it to obtain the line we want
  if (wrapper) {
    // Get relative positions
    var relLn = target.getLineNumber() - wrapper.getLineNumber();
    var relCl = target.getColumnNumber() - wrapper.getColumnNumber();

    console.log('LN', relLn, 'CL', relCl);

    var lines = target.getFunction().toString().split(/\n/);
    console.log('Line:', lines[ relLn ].substring(relCl));
  }

  var s = '' + this;
  frames.forEach(function (frame) {
    if (frame === null) {
      s += '\n ----------------------------------------';
    } else {
      s += '\n at ' + frame;
    }
  });
  return s;
};


module.exports = Failure;
