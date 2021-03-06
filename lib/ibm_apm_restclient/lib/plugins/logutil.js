'use strict';
var log4js = require('log4js');

var loglevel = process.env.KNJ_LOG_LEVEL ? process.env.KNJ_LOG_LEVEL.toUpperCase() : undefined;
if (!loglevel ||
    !(loglevel === 'OFF' || loglevel === 'ERROR' || loglevel === 'INFO' ||
        loglevel === 'DEBUG' || loglevel === 'ALL')) {
    loglevel = 'INFO';
}

exports.getLogger = function(tag) {
    var logger;
    if (process.env.KNJ_LOG_TO_CONSOLE) {
        log4js.loadAppender('console');
    } else {
        // log4js.clearAppenders()
        log4js.loadAppender('file');
        log4js.addAppender(log4js.appenders.file('nodejs_restclient.log'), tag);
    }

    logger = log4js.getLogger(tag);
    logger.setLevel(loglevel);

    return logger;
};

exports.getResourceRegisterDumper = function() {
    log4js.loadAppender('file');
    log4js.addAppender(log4js.appenders.file('resourceRegistry.log'), 'dumper');
    var logger = log4js.getLogger('dumper');
    logger.setLevel(loglevel);
    return logger;
};
