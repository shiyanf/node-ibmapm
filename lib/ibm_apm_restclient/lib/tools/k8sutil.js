// Copyright IBM Corp. 2017. All Rights Reserved.
// Node module: ibmapm
// This file is licensed under the Apache License 2.0.
// License text available at https://opensource.org/licenses/Apache-2.0
'use strict';
var log4js = require('log4js');
var logger = log4js.getLogger('knj_log');
var Api = require('kubernetes-client');
var fs = require('fs');
var os = require('os');
var QUERY_CONTAINER_ID_FILE = '/proc/self/cgroup';
var nodeName;
var namespace = process.env.KUBE_NAMESPACE;
var containerID;
var containerName;
var podName;
var podGenerateName;
var podID;
var podJson;
var core;
var ext;
var containerInfo;
var svcArray = [];
var svcNames = [];
var svcFullNames = [];
var svcIDs = [];
var nodeIPs = [];
var nodeArray = [];
var ingressUrl;
var deployment;
var NAMESPACE_DEFAULT = process.env.NAMESPACE_DEFAULT ? process.env.NAMESPACE_DEFAULT : 'ops-am';
var NAMESPACE_FILE = '/var/run/secrets/kubernetes.io/serviceaccount/namespace';
var isIcp = process.env.IS_ICP_ENV;
// var NAMESPACE_DEFAULT = 'default';

function K8sutil() {
    // this.getNamespace();
    podName = os.hostname();
    podGenerateName = podName.substr(0, podName.lastIndexOf('-'));
    logger.debug('k8sutil', 'K8sutil()', 'The pod name: ', podName);
    fetchContainerID();
    try {
        // var kubeconfig = Api.config.fromKubeconfig();
        var kubeconfig = Api.config.getInCluster();
        kubeconfig.promises = true;
        // kubeconfig.namespace = 'default';
        logger.info('k8sutil', 'K8sutil()', 'Kubeconfig', kubeconfig);
        core = new Api.Core(kubeconfig);
        ext = new Api.Extensions(kubeconfig);
        namespace = core.namespaces.namespace;
        logger.info('k8sutil', 'K8sutil()', 'core.namespaces.namespace', namespace);
        if (!podJson) {
            core.ns(namespace).pods(this.getPodName()).get().then(parsePodInfo).catch(
                function(err) {
                    logger.error('k8sutil', 'K8sutil()', err.message);
                }
            );
        }

    } catch (e) {
        logger.debug('k8sutil', 'K8sutil()',
            'Failed to load K8S configuration, is not a ICp environment.');
    }
    findIngressSvc();
    setNodeIPs();
}

function setNodeIPs() {
    try {
        core.nodes.get().then(
            function(result) {
                if (!result) {
                    return;
                }
                logger.debug('k8sutil', 'setNodeIPs()', 'The node info: ' + result.items.length);
                var items = result.items;
                for (var index = 0; index < items.length; index++) {
                    var element = items[index];
                    nodeArray.push(element);
                    nodeIPs.push(element.spec.externalID);
                }
                logger.debug('k8sutil', 'setNodeIPs()', 'The node IPs: ' + nodeIPs);

            }
        ).catch(function(e) {
            logger.error('k8sutil', 'setNodeIPs()', e.message);
        });
    } catch (e) {
        logger.debug('k8sutil', 'setNodeIPs()',
            'Failed to find nodes IPs, is not a ICp environment.');
    }
}
K8sutil.prototype.getNodes = function() {
    return nodeArray;
};

K8sutil.prototype.getNodeIPs = function() {
    logger.debug('k8sutil', 'getNodeIPs()', 'The node IPs from ICP is : ', nodeIPs);
    return nodeIPs;
};

function findIngressSvc() {
    logger.debug('k8sutil', 'findIngressSvc()', 'start...');
    try {
        core.ns(NAMESPACE_DEFAULT).svc.get().then(
            function(svcJson) {
                if (svcJson.items.length === 0) {
                    return;
                }
                for (var index = 0; index < svcJson.items.length; index++) {
                    var element = svcJson.items[index];
                    var name = element.metadata.name;
                    if (name.endsWith('ingress')) {
                        ingressUrl = 'http://' + name + '.' + NAMESPACE_DEFAULT +
                            '.svc.cluster.local/1.0/data';
                        process.env.IBAM_INGRESS_URL = ingressUrl;
                        logger.debug('k8sutil', 'findIngressSvc()',
                            'Find the ingressUrl from ICP is : ', ingressUrl);
                    }
                }
            }
        ).catch(
            function(e) {
                logger.error('k8sutil', 'findIngressSvc()', e.message);
            }
        );
    } catch (e) {
        logger.debug('k8sutil', 'findIngressSvc()',
            'Failed to find ingress URL.');
    }
}

K8sutil.prototype.getIngressUrl = function() {
    logger.debug('k8sutil', 'getIngressUrl()', 'The ingressUrl from ICP is : ', ingressUrl);
    return ingressUrl;
};

K8sutil.prototype.checkIngressUrl = function(callback) {
    logger.debug('k8sutil', 'checkIngressUrl()', 'The ingressUrl from ICP is : ', ingressUrl);

    if (ingressUrl) {
        process.env.IBAM_INGRESS_URL = ingressUrl;
        callback();
        return;
    }
    try {
        core.ns(NAMESPACE_DEFAULT).svc.get().then(
            function(result) {
                if (result.items.length === 0) {
                    return;
                }
                for (var index = 0; index < result.items.length; index++) {
                    var element = result.items[index];
                    var name = element.metadata.name;
                    if (name.endsWith('ingress')) {
                        ingressUrl = 'http://' + name + '.' + NAMESPACE_DEFAULT +
                            '.svc.cluster.local/1.0/data';
                        process.env.IBAM_INGRESS_URL = ingressUrl;
                        callback();
                        logger.debug('k8sutil', 'checkIngressUrl()',
                            'Find the ingressUrl from ICP is : ', ingressUrl);
                        return;
                    }
                }

            }
        ).catch(function(e) {
            logger.error('k8sutil', 'checkIngressUrl()',
                'There is no ingress service is found in the namespace ' +
                NAMESPACE_DEFAULT, e.message);
        });
    } catch (e) {
        logger.debug('k8sutil', 'checkIngressUrl()',
            'Failed to find ingress URL.');
    }
};


function parsePodInfo(result) {
    podJson = result;
    logger.debug('The pod: ', JSON.stringify(podJson));

    if (!podJson.status || !podJson.status.containerStatuses) {
        return;
    }

    for (var index = 0; index < podJson.status.containerStatuses.length; index++) {
        var element = podJson.status.containerStatuses[index];
        if (element.containerID &&
            element.containerID.indexOf(K8sutil.prototype.getContainerID())) {
            containerInfo = element;
            break;
        }
    }
    core.ns(namespace).svc.get().then(setServices).catch(function(e) {
        logger.error('k8sutil', 'parsePodInfo, faile to get service.', e.message);
    });
    setPodGenerateName(podJson);
    ext.ns(namespace).deploy.get().then(SetDeployments).catch(function(e) {
        logger.error('k8sutil', 'parsePodInfo, , faile to get deployment', e.message);
    });
    return;
}

function setPodGenerateName(podJson) {
    try {
        podGenerateName = podJson.metadata.generateName;
        if (podJson.metadata.labels['pod-template-hash']) {
            podGenerateName = podGenerateName
                .split('-' + podJson.metadata.labels['pod-template-hash'])[0];
        }
        logger.debug('k8sutil', 'setPodGenerateName', podGenerateName);

    } catch (err) {
        logger.error('k8sutil', 'setPodGenerateName', err.message);
    }

}
K8sutil.prototype.getPodGenerateName = function() {
    return podGenerateName;
};

function SetDeployments(deployJson) {
    var plabels = podJson.metadata.labels;
    logger.debug('k8sutil', 'SetDeployments', 'The num of deployments: ', deployJson.items.length);
    if (deployJson.items.length <= 0) {
        return;
    }
    for (let index = 0; index < deployJson.items.length; index++) {
        const element = deployJson.items[index];
        if (isPartOf(element.metadata.labels, plabels)) {
            logger.debug('k8sutil', 'SetDeployments', 'Set the deployment. ', element);
            deployment = element;
        }
    }
}

function isPartOf(prop1, prop2) {
    for (const key in prop1) {
        if (!prop2.hasOwnProperty(key) || prop1[key] !== prop2[key]) {
            return false;
        }
    }
    return true;
}

K8sutil.prototype.getDeployName = function() {
    if (deployment) {
        logger.debug('k8sutil', 'getDeployName', deployment.metadata.name);
        return deployment.metadata.name;
    }
};

function setServices(svcJson) {
    var plabels = podJson.metadata.labels;
    logger.debug('The num of services: ', svcJson.items.length);
    if (svcJson.items.length === 0) {
        return;
    }
    for (var index = 0; index < svcJson.items.length; index++) {
        var element = svcJson.items[index];
        var slabels = element.spec.selector;

        for (var key in slabels) {
            if (slabels.hasOwnProperty(key)) {
                var val1 = slabels[key];
                if (val1 === plabels[key]) {
                    svcArray.push(element);
                    break;
                }
            }
        }
    }
    logger.debug('The services of pod: ', svcArray);
}

K8sutil.prototype.getNamespace = function() {
    // if (namespace) {
    //     logger.debug('k8sutil.js', 'getNamespace', namespace);
    //     return namespace;
    // }
    // if (fs.existsSync(NAMESPACE_FILE)) {
    //     var tempcont = fs.readFileSync(NAMESPACE_FILE);
    //     var contArr = tempcont.toString().split(os.EOL);
    //     for (var index = 0; index < contArr.length; index++) {
    //         namespace = contArr[index];
    //         logger.debug('k8sutil.js', 'getNamespace', namespace,
    //             'from', NAMESPACE_FILE);
    //         return namespace;
    //     }
    // }
    // logger.debug('k8sutil.js', 'getNamespace', 'KUBE_NAMESPACE is not defined, and no ',
    //     NAMESPACE_FILE, 'either. ', 'will use default namespace.');
    // namespace = 'default';
    // return namespace;
    if (namespace) {
        return namespace;
    }
    if (fs.existsSync(NAMESPACE_FILE)) {
        var tempcont = fs.readFileSync(NAMESPACE_FILE);
        var contArr = tempcont.toString().split(os.EOL);
        for (var index = 0; index < contArr.length; index++) {
            namespace = contArr[index];
            logger.debug('k8sutil.js', 'getNamespace', namespace,
                'from', NAMESPACE_FILE);
            return namespace;
        }
    }
    try {
        namespace = core.namespaces.namespace;
    } catch (e) {
        logger.debug('k8sutil.js', 'getNamespace()',
            'Cannot get K8S namespace, is not a ICp environment.', namespace);
    }
    return namespace;
};

function fetchContainerID() {
    if (fs.existsSync(QUERY_CONTAINER_ID_FILE)) {
        var tempcont = fs.readFileSync(QUERY_CONTAINER_ID_FILE);
        var contArr = tempcont.toString().split(os.EOL);
        for (var index = 0; index < contArr.length; index++) {
            var element = contArr[index];
            if (element.indexOf('cpu') > 0 || element.indexOf('memory') > 0) {
                var tArr = element.split('/');
                containerID = tArr[tArr.length - 1];
                logger.debug('The container ID: ', containerID);
                return containerID;
            }
        }
    }
}

K8sutil.prototype.getContainerID = function getContainerID() {
    if (containerID) {
        return containerID;
    }
    return fetchContainerID();
};

K8sutil.prototype.getPodName = function getPodName() {
    if (podName) {
        return podName;
    }
    podName = os.hostname();
    podGenerateName = podName.substr(0, podName.lastIndexOf('-'));
    logger.debug('The pod name: ', podName);
    return podName;
};

K8sutil.prototype.isICP = function isICP() {
    if (isIcp !== undefined) {
        let ret = this.isTrue(isIcp);
        logger.debug('k8sutil.js', 'isICP()', ret);
        return ret;
    }

    try {
        core.ns(namespace).namespace;
        isIcp = true;
    } catch (e) {
        isIcp = false;
        logger.debug('k8sutil.js', 'isICP()',
            'Cannot get K8S namespace, is not a ICp environment.', namespace);
    }
    logger.debug('k8sutil.js', 'isICP()', isIcp);
    return false;
};

K8sutil.prototype.isTrue = function(v) {
    if (v && ['false', 'False', 'FALSE', ''].indexOf(v) < 0) {
        return true;
    } else {
        return false;
    }
};

K8sutil.prototype.getPodDetail = function getPodDetail() {
    return podJson;
};

K8sutil.prototype.getContainerDetail = function getContainerDetail() {
    return containerInfo;
};

K8sutil.prototype.getNodeName = function getNodeName() {
    if (nodeName) {
        return nodeName;
    }
    if (podJson) {
        nodeName = podJson.spec.nodeName;
    }
    return nodeName;
};

K8sutil.prototype.getPodID = function getPodID() {
    if (podID) {
        return podID;
    }
    if (podJson) {
        podID = podJson.metadata.uid;
    }
    return podID;
};

K8sutil.prototype.getContainerName = function getContainerName() {
    if (containerName) {
        return containerName;
    }
    if (containerInfo) {
        containerName = containerInfo.name;
    }
    return containerName;
};

K8sutil.prototype.getServicesConn = function getServicesConn() {
    var svcConn = [];
    for (var index = 0; index < svcArray.length; index++) {
        var svct = svcArray[index];
        var svcTemp = {
            uid: svct.metadata.uid,
            name: svct.metadata.name,
            namespace: svct.metadata.namespace,
            creationTimestamp: svct.metadata.creationTimestamp,
            connections: [],
            nodePort: [],
            port: [],
            ports: [],
            targetPort: [],
            mergeTokens: [],
            externalIPs: []
        };
        var ports = svct.spec.ports;
        svcTemp.ports = svcTemp.ports.concat(ports);
        for (var indexp = 0; indexp < ports.length; indexp++) {
            var ptemp = ports[indexp];
            svcTemp.mergeTokens.push(svct.spec.clusterIP + ':' + ptemp.port);
            if (ptemp.nodePort) {
                svcTemp.nodePort.push(ptemp.nodePort);
            }
            if (ptemp.targetPort) {
                svcTemp.targetPort.push(ptemp.targetPort);
            }
            svcTemp.port.push(ptemp.port);
        }

        if (svct.spec.clusterIP) {
            svcTemp.clusterIP = svct.spec.clusterIP;
            svcTemp.connections.push(svct.spec.clusterIP + ':' + svcTemp.port.toString());

        }
        if (svct.spec.externalIPs) {
            for (var index1 = 0; index1 < svct.spec.externalIPs.length; index1++) {
                var exIP = svct.spec.externalIPs[index1];
                svcTemp.connections.push(exIP + ':' + svcTemp.port.toString());
                svcTemp.externalIPs.push(exIP);
            }
            svcTemp.mergeTokens = svcTemp.mergeTokens
                .concat(combineArr(svcTemp.externalIPs, ':', svcTemp.port));
        }

        svcConn.push(svcTemp);
    }

    logger.debug('The service connections', svcConn);
    return svcConn;
};

function combineArr(array1, seprator, array2) {
    let ret = [];
    for (let index1 = 0; index1 < array1.length; index1++) {
        let item1 = array1[index1];
        for (let index2 = 0; index2 < array2.length; index2++) {
            let item2 = array2[index2];
            ret.push(item1 + seprator + item2);
        }
    }
    return ret;
}

K8sutil.prototype.getServiceName = function getServiceName() {
    if (svcNames.length > 0) {
        logger.debug('The service names:', svcNames);
        return svcNames;
    }

    for (let index = 0; index < svcArray.length; index++) {
        let svcitem = svcArray[index];
        svcNames.push(svcitem.metadata.name);
    }
    logger.debug('The service names:', svcNames);
    return svcNames;
};

K8sutil.prototype.getFullServiceName = function getFullServiceName() {
    if (svcFullNames.length > 0) {
        logger.debug('k8sutil.js', 'getFullServiceName', 'The full service names:', svcFullNames);
        return svcFullNames;
    }
    if (!namespace) {
        logger.debug('k8sutil.js', 'getFullServiceName', 'namespace is', namespace);
        return;
    }
    for (let index = 0; index < svcArray.length; index++) {
        let svcitem = svcArray[index];
        svcFullNames.push(namespace + '_service_' + svcitem.metadata.name);
    }
    logger.debug('k8sutil.js', 'getFullServiceName', 'The full service names:', svcFullNames);
    return svcFullNames;
};

K8sutil.prototype.getServiceID = function getServiceID() {
    if (svcIDs.length > 0) {
        logger.debug('k8sutil.js', 'getServiceID', 'The service IDs:', svcIDs);
        return svcIDs;
    }

    for (var index = 0; index < svcArray.length; index++) {
        var svct = svcArray[index];
        svcIDs.push(svct.metadata.uid);
    }
    logger.debug('k8sutil.js', 'getServiceID', 'The service IDs:', svcIDs);
    return svcIDs;
};
module.exports = new K8sutil();
