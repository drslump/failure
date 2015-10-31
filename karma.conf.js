module.exports = function (config) {

  var browsers = process.env.KARMA_BROWSERS
               ? process.env.KARMA_BROWSERS.split(',')
               : null;

  config.set({
    // logLevel: 'LOG_DEBUG',

    reporters: ['progress', 'saucelabs'],

    singleRun : true,
    autoWatch : true,

    frameworks: ['mocha', 'browserify'],//, 'source-map-support'],

    files: [
      'test/**/*.js'
    ],

    preprocessors: {
      'test/**/*.js': ['browserify']
    },

    browserify: {
      debug: true,
      configure: function (bro) {
        // Mocha is already included by Karma
        bro.exclude('mocha');
      }
    },

    // By default let's run on local browsers
    browsers: browsers || ['Chrome', 'Firefox', 'Safari'],

    // My home internet connection is really this bad :(
    browserDisconnectTimeout: 10*1000,
    browserDisconnectTolerance: 1,
    browserNoActivityTimeout: 4*60*1000,
    captureTimeout: 4*60*1000,

    customLaunchers: {
      sl_ie8: {
        base: 'SauceLabs',
        browserName: 'internet explorer',
        version: '8.0',
        platform: 'Windows XP',
        "record-video": false,
        "record-screenshot": false
      },
      sl_ie10: {
        base: 'SauceLabs',
        browserName: 'internet explorer',
        version: '10.0',
        platform: 'Windows 8',
        "record-video": false,
        "record-screenshot": false
      },
      sl_ie11: {
        base: 'SauceLabs',
        browserName: 'internet explorer',
        platform: 'Windows 8.1',
        version: '11',
        "record-video": false,
        "record-screenshot": false
      },
      sl_edge: {
        base: 'SauceLabs',
        browserName: 'microsoftedge',
        "record-video": false,
        "record-screenshot": false
      },
      sl_ff: {
        base: 'SauceLabs',
        browserName: 'firefox',
        "record-video": false,
        "record-screenshot": false
      },
      sl_gc: {
        base: 'SauceLabs',
        browserName: 'chrome',
        "record-video": false,
        "record-screenshot": false
      },
      sl_safari: {
        base: 'SauceLabs',
        browserName: 'safari',
        platform: 'OS X 10.9',
        "record-video": false,
        "record-screenshot": false
      },
      sl_ios: {
        base: 'SauceLabs',
        browserName: 'iphone',
        platform: 'OS X 10.9',
        version: '7.1',
        "record-video": false,
        "record-screenshot": false
      }
    },

    sauceLabs: {
      testName: 'Failure'
    }

  });
};
