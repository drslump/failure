// Outputs the source line referenced on each stack frame, generating something
// like this:
//
// Error: this should fail
//   at failure/examples/node-source-lines.js:54:3
//      assert(false, 'this should fail');
//   at it (failure/examples/node-source-lines.js:50:3)
//      fn();
//   at Object.<anonymous> (failure/examples/node-source-lines.js:53:1)
//      it('foo', function () {
//

var Failure = require('../').install();


function memoizeLines (file) {
  var fs = require('fs');
  var cache = memoizeLines.cache = memoizeLines.cache || {};
  if (!fs.existsSync(file)) {
    return cache[file] = [];
  }
  return cache[file] = fs.readFileSync(file).toString().split('\n');
}

// Override the default implementation with the Node custom logic
Failure.prototype.prepareStackTrace = function (frames) {
  var result = [this];
  var prefix = Failure.FRAME_PREFIX.replace(/[^\s]/g, ' ');

  for (var i=0; i < frames.length; i++) {
    var frame = frames[i];

    if (!frame) {
      result.push(Failure.FRAME_EMPTY);
      continue;
    }

    result.push(Failure.FRAME_PREFIX + frame);

    var lines = memoizeLines(frame.getFileName());
    var ln = frame.getLineNumber() - 1;
    var col = frame.getColumnNumber() - 1;
    if (lines[ln]) {
      result.push(prefix + lines[ln].slice(col, col + 60));
    }
  }

  return result.join('\n');
};



function assert (cond, msg) {
  if (!cond) {
    throw new Error(msg, assert);
  }
}

function it (title, fn) {
  fn();
}

it('foo', function () {
  assert(false, 'this should fail');
});
