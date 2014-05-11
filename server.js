/*global require, console, process */
"use strict";
var https = require("https");
var fs = require("fs");
var express = require("express");
var Q = require("q");
var caplib = require("./caplib");
var saver = require("./saver");
var log = function(text) {console.log(text);};

var domain;
var port;
var deferStart = Q.defer();
fs.readFile("capper.config", "utf8", function(err, data) {
    if (err) {log("bad capper.config file" + err); throw(err);}
    var config = JSON.parse(data);
    port = config.port;
    domain = config.protocol + "://" + config.domain + ":" + config.port + "/";
    log("config domain " + domain);
    deferStart.resolve(true);
});
var sslOptions = {
  key: fs.readFileSync('./ssl/server.key'),
  cert: fs.readFileSync('./ssl/server.crt'),
  ca: fs.readFileSync('./ssl/ca.crt'),
  requestCert: true,
  rejectUnauthorized: false
};
var app = express();
function parseBody(req, res, next) {
  req.rawBody = '';
  req.setEncoding('utf8');

  req.on('data', function(chunk) { 
    req.rawBody += chunk;
  });

  req.on('end', function() {
    try {req.body = JSON.parse(req.rawBody);} catch (e) {}
    next();
  });
}

function reviverToUIPath(reviver) {
    var revstring = "./apps/";
    var parts = reviver.split(".");
    revstring = revstring + parts[0] + "/ui/";
    var filename = parts.length > 1 ? parts[1] : "index";
    revstring += filename + ".html";
    log("ui path: " + revstring)
    return revstring;
}
function getObj(req) {
    var cred = req.query.s;
    var id = saver.credToId(cred);
    var reviver = saver.reviver(id);
    var live = saver.live(id);
    return {
        cred: cred,
        reviver: reviver,
        live: live,
        id: id,
        method: req.query.q
    };
}
/*
* webkeyToLive(wkeyObj) looks to see if the arg is a webkeyObject, if so, returns a live ref,
* otherwise returns the arg unchanged
*/
function webkeyToLive(wkeyObj) {
    try {
        if (wkeyObj["@"]) {
            var cred = wkeyObj["@"].split("#s=")[1];
            log("wkeyObj is webkey, cred is " + cred);
            return saver.live(saver.credToId(cred));
        } else {return wkeyObj;}
    } catch (err) {return wkeyObj;}
}
function idToWebkey(id) {
    return domain + "ocaps/#s=" + saver.idToCred(id);
}
app.get("/views/:filename", function(req, res) {
	res.sendfile("./views/" + req.params.filename);
});
app.get("/views/:path1/:filename", function(req, res) {
    res.sendfile("./views/" + req.params.path1 + "/" + req.params.filename);
});
app.get("/apps/:theapp/ui/:filename", function(req, res) {
    res.sendfile("./apps/" + req.params.theapp + "/ui/" + req.params.filename);
});
app.get('/', function(req, res) {
    res.sendfile('./views/index.html');
});
function showActor(req, res) {
    if (!req.query.s ) {
        res.sendfile("./bootstrap.html");
    } else {
        var objdata = getObj(req);
        if (!objdata.live) {res.send("no such object");}
        res.sendfile(reviverToUIPath(objdata.reviver));
    }
}
app.get("/ocaps/", showActor);

function invokeActor(req, res){
    log("post query " + JSON.stringify(req.query));
    log("post body: " + JSON.stringify(req.body));
    var objdata = getObj(req);
    if (!objdata.live) {
        res.send(JSON.stringify({"!": "bad object invoked"}));
        log("bad object invoked: " + JSON.stringify(req.query));
        return;
    }
    var args = req.body; //body already parsed
    var translatedArgs = [objdata.id, objdata.method];
    args.forEach(function(next) {translatedArgs.push(webkeyToLive(next));});
    var vowAns = saver.deliver.apply(null, translatedArgs);
    vowAns.then(function(ans) {
        try {
            var ansId = saver.asId(ans);
            var webkey = idToWebkey(ansId);
            res.send(JSON.stringify({"@": webkey}));            
        } catch (err) {
            if (ans === undefined) {ans = null;}
            var ansmap = {"=": ans};
            res.send(JSON.stringify(ansmap));            
        }      
   }, function(err){
        res.send(JSON.stringify({"!": err}));
   });
}
app.post("/ocaps/", parseBody, invokeActor);

deferStart.promise.then(function(){
    var argMap = caplib.argMap(process.argv);
    if ("-drop" in argMap) {
        saver.drop(saver.credToId(argMap["-drop"][0]));
        saver.checkpoint().then(function() {console.log("drop done");});
    } else if ("-make" in argMap){
        var obj = saver.make.apply(undefined, argMap["-make"]);
        if (!obj) {log("cannot find maker " + argMap["-make"]); return;}
        saver.checkpoint().then(function() {
            log(idToWebkey(saver.asId(obj)));
        });
    } else {
        var s = https.createServer(sslOptions, app);
        s.listen(port);    
    }
});
