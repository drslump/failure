// Uses the function's toString method to obtain the offending line.
// It requires the line raising the error to be inside a function and that
// function be wrapped in another on the same file.

var Failure = require('../');

var AssertionError = Failure.create('AssertionError', function (frames) {

  function getSrc (frame) {
    return frame.getFunction().toString().replace(/\s+/g, '');
  }

  // First frame is now the target
  var target = frames[0];

  // Filter out all frames which are not in the same file
  samefile = frames.filter(function (frame) {
    return frame && frame.getFileName() === target.getFileName();
  });

  // Get the closest function in the same file that wraps the target frame
  var wrapper;
  var targetSrc = getSrc(target);
  for (var i=1; i < samefile.length; i++) {
    var frame = samefile[i];
    if (!frame.getFunction()) {
      continue;
    }

    if (-1 !== getSrc(frame).indexOf(targetSrc)) {
      wrapper = frame;
      break;
    }
  }

  // When a wrapper function is found we can use it to obtain the line we want
  if (wrapper) {
    // Get relative positions
    var relLn = target.getLineNumber() - wrapper.getLineNumber();
    var relCl = target.getLineNumber() === wrapper.getLineNumber()
              ? 0
              : target.getColumnNumber() - 1;

    var lines = target.getFunction().toString().split(/\n/);
    if (lines[relLn]) {
      this.message += '\n\n  >> ' + lines[relLn].slice(relCl, relCl + 60) + '\n';
    }
  }

  return Failure.prototype.prepareStackTrace.call(this, frames);
});


function assert (cond, msg) {
  if (!cond) {
    throw new AssertionError(msg, assert);
  }
}

function it (title, fn) {
  try {
    fn();
  } catch (e) {
    console.log('- ' + title);
    console.log(e.stack);
  }
}

it('target line', function () {
  assert(false, 'this should fail');
});
