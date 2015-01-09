# Failure

Customizable Error replacement for JavaScript.


## Features

- Leverage [V8's StackTrace API](https://code.google.com/p/v8-wiki/wiki/JavaScriptStackTraceApi)
- Partial fallback compatibility for other engines
- Deferred stack generation for optimized runtime performance
- Trimmed stack traces to hide implementation details
- Stack trace manipulation based on [CallSite](lib/call-site.js) frame objects
- Async stack traces (aka *Long stack traces*) support


## Customization

`Failure` instances expose a `.frames` property holding an array of *CallSite*
objects representing the frames in the stack trace. Since we have now a
programmatic interface to inspect the stack instead of the standard string based
approach it becomes much easier to manipulate it.

For instance we can filter out unwanted frames from it:

```js
var MyError = Failure.create('MyError', {
  buildStackTrace: function () {
    // Remove frames from a debug library
    this.frames = this.frames.filter(function (frame) {
      return !/my-debug-lib.js$/.test(frame.getFileName());
    });
    return Failure.prototype.buildStackTrace.call(this);
  }
});
```

## Trimmed stack traces

Say you have a cool assertions library but when throwing an error you internal
library functions are always present in the stack trace. You can trim the stack
trace so that they are automatically removed by passing a function reference
as second argument to the `Failure` constructor.

```js
function raise (message) {
  throw new Failure(message, assert);
}

function assert (cond, message) {
  if (!cond) raise(message);
}

function test () {
  assert(false, 'this should raise an error');
}

test();
```

Which generates this (notice how nor `assert` neither `raise` are included):

```sh
Failure: this should raise an error
 at test (test.js:10:3)
 at Object.<anonymous> (test.js:13:1)
```

## Async stack traces

When working with asynchronous code flows the stack trace is often times helpless
since we just get the frames from the main event loop but nothing about where was
the function scheduled. `Failure.track` allows to annotate functions with a stack
trace when scheduling, this way we can re-construct the whole stack trace when an
error is thrown.

```js
function doAsync () {
  setTimeout(Failure.track(function () {
    throw new Failure('Async error');
  }), 1000);
}

doAsync();
```

The snippet above generates:

```sh
Failure: Async error
 at null._onTimeout (test.js:3:11)
 ----------------------------------------
 at doAsync (test.js:2:22)
 at Object.<anonymous> (test.js:7:1)
```

> **Note**: The helpers `Failure.setTimeout` and `Failure.nextTick` are available
  to simplify the use of those common functions.

Tracking function execution comes with a performance cost, both in memory and CPU,
when the function is annotated the current stack trace information must be
computed. *Failure* uses a deferred algorithm to make this operation as fast as
possible but it's still expensive, so avoid using it if you need to register a
callback very frequently. Note however that the cost is when defining the callback,
the invokation is unaffected.

> **Hint**: The whole tracking mechanism can be globally disabled with
  `Failure.TRACK = false`.

> **Caution**: Using the native `.bind` method (on the V8 engine at least)
  creates a new function reference but it gets inlined and isn't available when
  querying the call stack. The result is that it's not possible to track those
  function calls, see the next section for a work around.

### Tracking multiple calls

`Failure.track` doesn't wrap the function before annotating it, this means that
each function will only track the latest registration. This behaviour is intended
since it's faster and more importantly it solves issues with APIs using function
references for *unregistering*.

It's easy enough to work around this if you really need to track multiple code
paths. Just generate a new function before tracking them, this can be accomplished
in a number of ways, here is an example:

```js
function doWork() {
  throw new Failure('work failed');
}

// Wrap in an anonymous function
Failure.setTimeout(function () { doWork(); }, 10);
// Use Failure.wrap
setTimeout(Failure.wrap(doWork), 2000);
```

Now if there is a failure in `doWork` it'll correctly report the stack trace:

```sh
Failure: work failed
 at doWork (test.js:2:9)
 at null._onTimeout (test.js:6:34)
 ----------------------------------------
 at Object.<anonymous> (test.js:6:9)  <-- NOTE: it rightly points to the origin
```

### Bonus: include .track in the Function prototype

If you don't mind augmenting prototypes you can use this snippet to ease the use
of track.

```js
Function.prototype.track = function (wrap) {
  return wrap ? Failure.wrap(this) : Failure.track(this);
};
```

Then you can simply use it like so:

```js
setTimeout(function () { console.log('foo'); }.track());
$('.id').click(handleClick.track(true));
```
