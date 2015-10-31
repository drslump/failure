describe('custom failure error', function () {

  var assert = require('assert');
  var Failure = require('../');

  // Creates a custom failure that suited for execution in a Mocha/Jasmine
  // pattern where errors are raised from a function defined inside another
  // (describe -> it), allowing to extract the offending line to show it as
  // part of the error without requiring access to the original source file.
  var AssertionError = Failure.create('AssertionError', function (frames) {

    function getSrc (frame) {
      if (!frame) return null;
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

  // Exclude mocha files
  AssertionError.exclude(/\bmocha\b/);
  // Exclude node internals
  AssertionError.exclude(/^(node|module)\.js$/);

  // Make mocha keep the stacktrace at definition time so we can access the
  // the wrapper function when a failure is raised.
  Failure.patch(global, 'it', 1);
  Failure.patch(global, 'beforeEach', 0);
  Failure.patch(global, 'afterEach', 0);

  // Emulate an assertion library
  function coolAssert (sut) {
    throw new AssertionError("CoolAssert failure", coolAssert);
  }

  it('should display the offending line', function () {
    var isIE = 'ActiveXObject' in global;

    try {
      coolAssert("foo");
    } catch (e) {
      var lines = e.stack.split(/\n/);

      // console.log(e.stack);

      // Preface
      assert.equal(lines[0], 'AssertionError: CoolAssert failure');

      if (isIE) {
        console.log('offending line extraction is not supported on IE');
      } else {
        assert.equal(lines[1], '');
        // Note diff browsers provide different accuracy so be flexible
        assert(/\("foo"\)/.test(lines[2]), lines[2]);
        assert.equal(lines[3], '');
      }

      // Execution frame
      assert(/^  at /.test(lines[4]), lines[4]);
      // Split frame
      assert(/^  ----/.test(lines[5]), lines[5]);
      // Declaration frames
      assert(/^  at /.test(lines[6]), lines[6]);
    }

  });

});
