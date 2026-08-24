/**
 * CSInterface - v11.0.0
 * Adobe CEP JavaScript Interface library
 */
var CSInterface = function () {
};

CSInterface.prototype.hostEnvironment = window.__adobe_cep__ ? JSON.parse(window.__adobe_cep__.getHostEnvironment()) : null;

CSInterface.prototype.evalScript = function (script, callback) {
    if (window.__adobe_cep__) {
        if (callback === null || callback === undefined) {
            callback = function (result) {};
        }
        window.__adobe_cep__.evalScript(script, callback);
    } else {
        console.warn("window.__adobe_cep__ not available. Running mock or standalone.");
        if (callback) callback("mock_result");
    }
};

CSInterface.prototype.getHostEnvironment = function () {
    return this.hostEnvironment;
};

CSInterface.prototype.closeExtension = function () {
    if (window.__adobe_cep__) {
        window.__adobe_cep__.closeExtension();
    }
};

CSInterface.prototype.getSystemPath = function (pathType) {
    var path = "";
    if (window.__adobe_cep__) {
        path = decodeURI(window.__adobe_cep__.getSystemPath(pathType));
    }
    return path;
};

CSInterface.prototype.requestOpenExtension = function (extensionId, params) {
    if (window.__adobe_cep__) {
        window.__adobe_cep__.requestOpenExtension(extensionId, params);
    }
};

CSInterface.prototype.addEventListener = function (type, listener, obj) {
    if (window.__adobe_cep__) {
        window.__adobe_cep__.addEventListener(type, listener, obj);
    }
};

CSInterface.prototype.removeEventListener = function (type, listener, obj) {
    if (window.__adobe_cep__) {
        window.__adobe_cep__.removeEventListener(type, listener, obj);
    }
};

CSInterface.prototype.dispatchEvent = function (event) {
    if (window.__adobe_cep__) {
        window.__adobe_cep__.dispatchEvent(event);
    }
};

CSInterface.prototype.resizeContent = function (width, height) {
    if (window.__adobe_cep__) {
        window.__adobe_cep__.resizeContent(width, height);
    }
};

CSInterface.prototype.openURLInDefaultBrowser = function (url) {
    if (window.__adobe_cep__) {
        cep.util.openURLInDefaultBrowser(url);
    }
};

SystemPath = {
    USER_DATA: "userData",
    COMMON_FILES: "commonFiles",
    MY_DOCUMENTS: "myDocuments",
    APPLICATION: "application",
    EXTENSION: "extension",
    HOST_APPLICATION: "hostApplication"
};
