// Copyright IBM Corp. 2017. All Rights Reserved.
// Node module: ibmapm
// This file is licensed under the Apache License 2.0.
// License text available at https://opensource.org/licenses/Apache-2.0
'use strict';
var url = require('url');
var http = require('http');
var https = require('https');
var HttpsProxyAgent = require('./https-proxy-agent');
var request = require('request');
var zlib = require('zlib');
var logger = require('../plugins/logutil').getLogger('restclient_sender-queue.js');
var resourceRegistryDumper = require('../plugins/logutil').getResourceRegisterDumper();

var pluginconfig = require('./config').pluginConfig;
// var loadplugin = pluginconfig.loadPluginsConf('D:/vscodews/ibm_apm_restclient/test/config.json');

var httpProxy;
var proxyAgent;

var queues = {};

var senderQueueLoop = [];

var MAX_RETRY_TIMES = process.env.KNJ_RESTCLIENT_MAX_RETRY || 3;

SenderQueue.prototype.send = function(task, quequeName) {
    // special for cloudnative register
    if (task.success || task.empty) {
        return;
    }
    if (task.retry) {
        logger.debug('retring ' + task.retry + ' ...');
    }

    if (process.env.DC_TEST_MODE) {
        task.success = true;
        return;
    }

    let urlMap = url.parse(task.url);
    let sendmethod = urlMap.protocol === 'https:' ? https : http;
    let payloadString = task.payload;
    if (!task.additionalHeader ||
        !task.additionalHeader['Content-Type'] ||
        task.additionalHeader['Content-Type'] === 'application/json') {
        payloadString = (typeof task.payload === 'object') ?
            JSON.stringify(task.payload) : task.payload;
    }

    let header = {
        'Content-Type': 'application/json',
        'Content-Length': payloadString.length
    };

    if (task.gzipped) {
        header['Content-Encoding'] = 'gzip';
        payloadString = zlib.gzipSync(payloadString);
        header['Content-Length'] = payloadString.length;
    }
    let key;
    if (task.additionalHeader) { // mixin additionalHeader and header
        for (key in task.additionalHeader) {
            header[key] = task.additionalHeader[key];
        }
    }
    let options = {
        hostname: urlMap.hostname,
        host: urlMap.host,
        path: urlMap.path,
        method: 'POST',
        agent: false,
        port: urlMap.port,
        rejectUnauthorized: false,
        headers: header
    };
    if (urlMap.auth) {
        options.auth = urlMap.auth;
    }
    if (!urlMap.port) {
        options.port = urlMap.protocol === 'https:' ? 443 : 80;
    }
    if (task.addtionalOptions) {
        for (key in task.addtionalOptions) {
            options[key] = task.addtionalOptions[key];
        }
    }
    logger.debug('Post payload to ' + task.url + ' ; header: ' +
        JSON.stringify(options.headers) + ' ; payload: ' + payloadString);

    if (task.type.indexOf('resources: ') === 0) {
        resourceRegistryDumper.info('Post payload to ' + task.url + ' ; header: ' +
            JSON.stringify(options.headers) + ' ; payload: ' + payloadString);
    }
    if (process.env.KNJ_PROXY && urlMap.protocol === 'http:') {
        sendThrouHTTPProxy(options, task, payloadString);

    } else {
        if (process.env.KNJ_PROXY && urlMap.protocol === 'https:') {
            if (!proxyAgent) {
                proxyAgent = new HttpsProxyAgent(process.env.KNJ_PROXY);
            }
            options.agent = proxyAgent;
        }
        sendData(options, sendmethod, task, quequeName, payloadString);
    };

};

function sendData(options, sendmethod, task, quequeName, payloadString) {

    var req = sendmethod.request(options, function(res) {
        logger.debug('Request ', task.type, 'To', task.url,
            ' Response statusCode: ', res.statusCode);
        if (res.statusCode >= 200 && res.statusCode < 300) {
            task.success = true;
        } else {
            if (task.retry < MAX_RETRY_TIMES) {
                task.retry++;
                var i = task.retry;
                while (i >= 0) {
                    exports.getQueue(quequeName).addTask({ empty: true, type: task.type });
                    i--;
                }
                exports.getQueue(quequeName).addTask(task);
            }
        }
        res.on('data', function(d) {
            logger.debug('Request ' + task.type + ' response: ' + d.toString());
        });
        res.on('error', function(error) {
            logger.error('Request ' + task.type + ' response error: ' + error);
        });
        if (task.callback) {
            task.callback(null, res);
        }
    });
    req.on('error', function(error) {
        if (task.retry < MAX_RETRY_TIMES) {
            task.retry++;
            let retrycount = task.retry;
            while (retrycount >= 0) {
                exports.getQueue(quequeName).addTask({ empty: true, type: task.type });
                retrycount--;
            }
            exports.getQueue(quequeName).addTask(task);
        }
        logger.error('Request ' + task.type + ' request error:' + error);
        if (task.callback) {
            task.callback(error);
        }
    });
    // logger.debug(payloadString);
    req.write(payloadString);
    req.end();
}

function sendThrouHTTPProxy(options, task, payloadString) {
    httpProxy = httpProxy || request.defaults({
        proxy: process.env.KNJ_PROXY,
        rejectUnauthorized: false
    });
    try {
        httpProxy.post('http://' + options.hostname + ':' + options.port + options.path, {
            body: payloadString,
            headers: options.headers
        }, function(err, resp, body) {
            if (err) {
                logger.error('Request ' + task.type + ' through proxy, Error:', err);
            }
            if (resp) {
                logger.debug('Request ' + task.type + ' through proxy, response statusCode: ' +
                    resp.statusCode);
            }
        });
    } catch (e) {
        logger.error('Request ' + task.type + ' through proxy, Error:', e.message);
        logger.error('Request ' + task.type + ' through proxy, Error:', e.stack);
    }
}

function SenderQueue(name) {
    this.name = name;
    this.dcQueue = [];
    this.resourceQueue = [];
    this.metricQueue = [];
    this.aarQueue = [];
    this.adrQueue = [];
    this.jsoQueue = [];
    this.metaQueue = [];
    this.amuiQueue = [];
}

SenderQueue.prototype.addTask = function(task) {
    if (task.type === 'dc') {
        if (pluginconfig.dcconsumers.length === 0) {
            logger.debug('No consumers on dc queue. give up the payload!');
            return; // no one monitor dc queue, give up the payload directly
        }

        this.dcQueue.push(task);
        if (pluginconfig.dcqueue.batchSize <= this.dcQueue.length) {
            queues[this.name].consumeDC();
        }

    } else if (task.type && task.type.indexOf('resources:') === 0) {
        if (pluginconfig.resourceconsumers.length === 0) {
            logger.debug('No consumers on resource queue. give up the payload!');
            return; // no one monitor resource queue, give up the payload directly
        }

        this.resourceQueue.push(task);
        if (pluginconfig.resourcequeue.batchSize <= this.resourceQueue.length) {
            queues[this.name].consumeResource();
        }
    } else if (task.type && task.type.indexOf('metrics:') === 0) {
        if (pluginconfig.metricconsumers.length === 0) {
            logger.debug('No consumers on metric queue. give up the payload!');
            return; // no one monitor metric queue, give up the payload directly
        }

        this.metricQueue.push(task);
        if (pluginconfig.metricqueue.batchSize <= this.metricQueue.length) {
            queues[this.name].consumeMetric();
        }
    } else if (task.type && task.type.indexOf('aar:') === 0) {
        if (pluginconfig.aarconsumers.length === 0) {
            logger.debug('No consumers on aar queue. give up the payload!');
            return; // no one monitor aar queue, give up the payload directly
        }

        this.aarQueue.push(task);
        if (pluginconfig.aarqueue.batchSize <= this.aarQueue.length) {
            queues[this.name].consumeAAR();
        }
    } else if (task.type && task.type.indexOf('adr:') === 0) {
        if (pluginconfig.adrconsumers.length === 0) {
            logger.debug('No consumers on adr queue. give up the payload!');
            return; // no one monitor adr queue, give up the payload directly
        }
        this.adrQueue.push(task);
        if (pluginconfig.adrqueue.batchSize <= this.adrQueue.length) {
            queues[this.name].consumeADR();
        }
    } else if (task.type && task.type.indexOf('jso:') === 0) {
        if (pluginconfig.jsoconsumers.length === 0) {
            logger.debug('No consumers on jso queue. give up the payload!');
            return; // no one monitor jso queue, give up the payload directly
        }
        this.jsoQueue.push(task);
        if (pluginconfig.jsoqueue.batchSize <= this.jsoQueue.length) {
            queues[this.name].consumeJSO();
        }
    } else if (task.type && task.type.indexOf('metadata:') === 0) {
        if (pluginconfig.metaconsumers.length === 0) {
            logger.debug('No consumers on meta queue. give up the payload!');
            return; // no one monitor jso queue, give up the payload directly
        }
        this.metaQueue.push(task);
        if (pluginconfig.metaqueue.batchSize <= this.metaQueue.length) {
            queues[this.name].consumeMETA();
        }
    } else if (task.type && task.type.indexOf('amui:') === 0) {
        if (pluginconfig.amuiconsumers.length === 0) {
            logger.debug('No consumers on amui queue. give up the payload!');
            return; // no one monitor jso queue, give up the payload directly
        }
        this.amuiQueue.push(task);
        if (pluginconfig.amuiqueue.batchSize <= this.amuiQueue.length) {
            queues[this.name].consumeAMUI();
        }
    }
    // else {
    //     this.other.push(task);
    // }
};

var EventEmitter = require('events').EventEmitter;
var event = new EventEmitter();


SenderQueue.prototype.consumeDC = function() {
    // sequence: dc -> resource -> metric -> aar/adr
    logger.debug('consumeDC');
    if (
        this.dcQueue.length) {
        logger.debug('dcQueue.length=', this.dcQueue.length);
    }

    if (this.dcQueue.length > 0) {
        var tasks = [];
        if (pluginconfig.dcqueue.batchSize > 0) {
            var batchsize = pluginconfig.dcqueue.batchSize > this.dcQueue.length ?
                this.dcQueue.length : pluginconfig.dcqueue.batchSize;
            for (var index = 0; index < batchsize; index++) {
                tasks.push(this.dcQueue.shift());
            }
        } else {
            tasks.push(this.dcQueue.shift());
        }
        if (tasks) {
            event.emit('httpsend', tasks, this.name, pluginconfig.queuetypes.DC);
        }
    }

};

SenderQueue.prototype.consumeMetric = function() {
    // sequence: dc -> resource -> metric -> aar/adr
    logger.debug('consumeMetric');
    if (this.metricQueue.length) {
        logger.debug('metricQueue.length=', this.metricQueue.length);
    }

    if (this.metricQueue.length > 0) {
        var tasks = [];
        if (pluginconfig.metricqueue.batchSize > 0) {
            var batchsize = pluginconfig.metricqueue.batchSize > this.metricQueue.length ?
                this.metricQueue.length : pluginconfig.metricqueue.batchSize;
            for (var index = 0; index < batchsize; index++) {
                tasks.push(this.metricQueue.shift());
            }
        } else {
            tasks.push(this.metricQueue.shift());
        }

        if (tasks) {
            event.emit('httpsend', tasks, this.name, pluginconfig.queuetypes.METRICS);
        }
    }

};

SenderQueue.prototype.consumeResource = function() {
    // sequence: dc -> resource -> metric -> aar/adr
    logger.debug('consumeResource');
    if (this.resourceQueue.length) {
        logger.debug('resourceQueue.length=', this.resourceQueue.length);
    }

    if (this.resourceQueue.length > 0) {
        var tasks = [];
        if (pluginconfig.resourcequeue.batchSize > 0) {
            var batchsize = pluginconfig.resourcequeue.batchSize > this.resourceQueue.length ?
                this.resourceQueue.length : pluginconfig.resourcequeue.batchSize;

            for (var index = 0; index < batchsize; index++) {
                tasks.push(this.resourceQueue.shift());
            }
        } else {
            tasks.push(this.resourceQueue.shift());
        }
        if (tasks) {
            event.emit('httpsend', tasks, this.name, pluginconfig.queuetypes.RESOURCE);
        }
    }

};

SenderQueue.prototype.consumeAAR = function() {
    // sequence: dc -> resource -> metric -> aar/adr
    logger.debug('consumeAAR');
    if (this.aarQueue.length) {
        logger.debug('aarQueue.length=', this.aarQueue.length);
    }

    if (this.aarQueue.length > 0) {
        var tasks = [];
        if (pluginconfig.aarqueue.batchSize > 0) {
            var batchsize = pluginconfig.aarqueue.batchSize > this.aarQueue.length ?
                this.aarQueue.length : pluginconfig.aarqueue.batchSize;
            for (var index = 0; index < batchsize; index++) {
                tasks.push(this.aarQueue.shift());
            }
        } else {
            tasks.push(this.aarQueue.shift());
        }
        if (tasks) {
            event.emit('httpsend', tasks, this.name, pluginconfig.queuetypes.AAR);
        }
    }

};

SenderQueue.prototype.consumeADR = function() {
    // sequence: dc -> resource -> metric -> aar/adr
    logger.debug('consumeADR');
    if (this.adrQueue.length) {
        logger.debug('adrQueue.length=', this.adrQueue.length);
    }

    if (this.adrQueue.length > 0) {
        var tasks = [];
        if (pluginconfig.adrqueue.batchSize > 0) {
            var batchsize = pluginconfig.adrqueue.batchSize > this.adrQueue.length ?
                this.adrQueue.length : pluginconfig.adrqueue.batchSize;
            for (var index = 0; index < batchsize; index++) {
                tasks.push(this.adrQueue.shift());
            }
        } else {
            tasks.push(this.adrQueue.shift());
        }
        if (tasks) {
            event.emit('httpsend', tasks, this.name, pluginconfig.queuetypes.AAR);
        }
    }

};


SenderQueue.prototype.consumeJSO = function() {
    // sequence: dc -> resource -> metric -> aar/adr
    logger.debug('consumeJSO');
    if (this.jsoQueue.length) {
        logger.debug('jsoQueue.length=', this.jsoQueue.length);
    }

    if (this.jsoQueue.length > 0) {
        var tasks = [];
        if (pluginconfig.jsoqueue.batchSize > 0) {
            var batchsize = pluginconfig.jsoqueue.batchSize > this.jsoQueue.length ?
                this.jsoQueue.length : pluginconfig.jsoqueue.batchSize;
            for (var index = 0; index < batchsize; index++) {
                tasks.push(this.jsoQueue.shift());
            }
        } else {
            tasks.push(this.jsoQueue.shift());
        }
        if (tasks) {
            event.emit('httpsend', tasks, this.name, pluginconfig.queuetypes.JSO);
        }
    }

};

SenderQueue.prototype.consumeMETA = function() {
    logger.debug('consumeMETA');
    if (this.metaQueue.length) {
        logger.debug('metaQueue.length=', this.metaQueue.length);
    }

    if (this.metaQueue.length > 0) {
        var tasks = [];
        if (pluginconfig.metaqueue.batchSize > 0) {
            var batchsize = pluginconfig.metaqueue.batchSize > this.metaQueue.length ?
                this.metaQueue.length : pluginconfig.metaqueue.batchSize;
            for (var index = 0; index < batchsize; index++) {
                tasks.push(this.metaQueue.shift());
            }
        } else {
            tasks.push(this.metaQueue.shift());
        }
        if (tasks) {
            event.emit('httpsend', tasks, this.name, pluginconfig.queuetypes.META);
        }
    }

};
SenderQueue.prototype.consumeAMUI = function() {
    logger.debug('consumeAMUI');
    if (this.amuiQueue.length) {
        logger.debug('amuiQueue.length=', this.amuiQueue.length);
    }

    if (this.amuiQueue.length > 0) {
        var tasks = [];
        if (pluginconfig.amuiqueue.batchSize > 0) {
            var batchsize = pluginconfig.amuiqueue.batchSize > this.amuiQueue.length ?
                this.amuiQueue.length : pluginconfig.amuiqueue.batchSize;
            for (var index = 0; index < batchsize; index++) {
                tasks.push(this.amuiQueue.shift());
            }
        } else {
            tasks.push(this.amuiQueue.shift());
        }
        if (tasks) {
            event.emit('httpsend', tasks, this.name, pluginconfig.queuetypes.AMUI);
        }
    }

};
event.on('httpsend', queueListener);

function cloneTask(task) {
    if (task instanceof Array) {
        let newTask = [];
        task.forEach(function(element) {
            newTask.push(JSON.parse(JSON.stringify(element)));
        });
        return newTask;
    } else {
        return JSON.parse(JSON.stringify(task));
    }
}

function queueListener(task, quequeName, type) {
    var res = {
        statusCode: 202
    };
    var consumersArr = [];
    if (pluginconfig.queuetypes.DC === type) {
        consumersArr = pluginconfig.dcconsumers;
    } else if (pluginconfig.queuetypes.AAR === type) {
        consumersArr = pluginconfig.aarconsumers;
    } else if (pluginconfig.queuetypes.ADR === type) {
        consumersArr = pluginconfig.adrconsumers;
    } else if (pluginconfig.queuetypes.RESOURCE === type) {
        consumersArr = pluginconfig.resourceconsumers;
    } else if (pluginconfig.queuetypes.METRICS === type) {
        consumersArr = pluginconfig.metricconsumers;
    } else if (pluginconfig.queuetypes.JSO === type) {
        consumersArr = pluginconfig.jsoconsumers;
    } else if (pluginconfig.queuetypes.META === type) {
        consumersArr = pluginconfig.metaconsumers;
    } else if (pluginconfig.queuetypes.AMUI === type) {
        consumersArr = pluginconfig.amuiconsumers;
    }

    var theCallback = null;
    if (Array.isArray(task)) {
        theCallback = task[0].callback;
    } else {
        theCallback = task.callback;
    }
    consumersArr.forEach(function(element) {
        try {
            let newTask = cloneTask(task);
            element.send(newTask, theCallback);
        } catch (error) {
            logger.error('failed to call customized consumer, Error:', error);
            res.statusCode = 400;
            res.error = error;
        }
    }, this);
    if (theCallback) {
        theCallback(null, res);
    }
};


exports.getQueue = function(name) {

    if (!queues[name]) {
        queues[name] = new SenderQueue(name);
        var intervalDC = setInterval(function() { queues[name].consumeDC(); },
            pluginconfig.dcqueue.freq);
        intervalDC.unref();
        senderQueueLoop.push(intervalDC);

        var intervalMetric = setInterval(function() { queues[name].consumeMetric(); },
            pluginconfig.metricqueue.freq);
        intervalMetric.unref();
        senderQueueLoop.push(intervalMetric);

        var intervalTopo = setInterval(function() { queues[name].consumeResource(); },
            pluginconfig.resourcequeue.freq);
        intervalTopo.unref();
        senderQueueLoop.push(intervalTopo);

        var intervalAAR = setInterval(function() { queues[name].consumeAAR(); },
            pluginconfig.aarqueue.freq);
        intervalAAR.unref();
        senderQueueLoop.push(intervalAAR);

        var intervalADR = setInterval(function() { queues[name].consumeADR(); },
            pluginconfig.adrqueue.freq);
        intervalADR.unref();
        senderQueueLoop.push(intervalADR);

        var intervalJSO = setInterval(function() { queues[name].consumeJSO(); },
            pluginconfig.jsoqueue.freq);
        intervalJSO.unref();
        senderQueueLoop.push(intervalJSO);

        var intervalMeta = setInterval(function() { queues[name].consumeMETA(); },
            pluginconfig.metaqueue.freq);
        intervalMeta.unref();
        senderQueueLoop.push(intervalMeta);

        var intervalAMUI = setInterval(function() { queues[name].consumeAMUI(); },
            pluginconfig.amuiqueue.freq);
        intervalAMUI.unref();
        senderQueueLoop.push(intervalAMUI);
    }
    return queues[name];
};

exports.stopQueue = function() {
    senderQueueLoop.forEach(function(item) {
        clearInterval(item);
    });
};
