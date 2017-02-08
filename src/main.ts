import { BehaviorSubject, Subject} from '@reactivex/rxjs';
import * as express from 'express';
import { WebServer, viwiWebSocket } from "./expressapp";
import { viwiClientWebSocketMessage } from "./types";
import * as uuid from "uuid";
import * as fs from "fs";
import * as path from "path";
import { Service, Resource, Element, ResourceUpdate } from "./plugins/viwiPlugin";
import { viwiLogger } from "./log";


/**
 * parse command line options
 */
const commandLineArgs = require('command-line-args')
const optionDefinitions = [
  { name: 'verbosity', alias: 'v', type: String }
]
const cla = commandLineArgs(optionDefinitions);
/** end parse command line argunments */

const logger = viwiLogger.getInstance().getLogger("general");
logger.transports["console"].level = cla.verbosity || 'verbose'; // for debug

declare function require(moduleName: string): any;

const PLUGINDIR = path.join(__dirname, "plugins");
const URIREGEX = /^\/(\w+)\/(\w+)\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fAF]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})?#?\w*\??([\w$=&\(\)\:\,\;\-\+]*)?$/; //Group1: Servicename, Group2: Resourcename, Group3: element id, Group4: queryparameter list
const BASEURI = "/";

var unsubscriptions:Subject<string> = new Subject();

var availableServices:{id:string;name:string;uri:string}[] = [];

// set up the server
var server:WebServer;

var run = (port?:number):Promise<void> => {
  return new Promise<void>((resolve, reject) => {
    server = new WebServer(port);
    server.init(); // need to init

    server.app.get(BASEURI, (req: express.Request, res: express.Response, next: express.NextFunction) => {
      // respond
      res.status(200);
      res.json({
        status: "ok",
        data: availableServices
      });
    });


    /**
     * Plugin loader
     * 
     * browses the PLUGINDIR for available plugins and registers them with the viwi sevrer 
     */
    fs.readdir(path.join(__dirname, "plugins"), (err:NodeJS.ErrnoException, files: string[]) => {
      if(err) {
        throw err;
      }
      files.forEach(file => {
        let plugin = path.join(PLUGINDIR, file);
        if(fs.lstatSync(plugin).isDirectory()) {
          let _plugin = require(plugin);
          let service:Service = new _plugin.Service();
          availableServices.push({
            id: service.id,
            name: service.name,
            uri: BASEURI + service.name.toLowerCase() + "/"
          });
          server.app.get(BASEURI + service.name.toLowerCase() + "/", serviceGET(service));
          logger.info("Loading Plugin:", service.name);
          service.resources.map((resource:Resource) => {
            let basePath = BASEURI + service.name.toLowerCase() + "/" + resource.name.toLowerCase() + "/";
            server.app.get(basePath, resourceGET(service, resource));               //READ
            server.app.post(basePath, resourcePOST(service, resource));             //CREATE
            server.app.post(basePath + ':id', elementPOST(service, resource));      //READ
            server.app.get(basePath + ':id', elementGET(service, resource));        //UPDATE
            server.app.delete(basePath + ':id', elementDELETE(service, resource));  //DELETE
            server.ws.on('connection', (ws:any) => {                                //subscribe
              ws.on("message", handleWebSocketMessages(service, resource, ws));
            });
          });
        }
      });
      resolve();
    });
  });
};


/**
 * retrieve all resources of a service
 * 
 * @param service the service to discover
 * 
 * returns an express route callback
 */
const serviceGET = (service:Service) => {

  let resources:Array<any> = service.resources.map((res:Resource)=>{
    return {
      name: res.name.toLowerCase(),
      uri: BASEURI + service.name.toLowerCase() + "/" + res.name.toLowerCase() + "/"
    }
  });

  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.status(200);
    res.json({
      status: "ok",
      data: resources
    });
  };
};

/**
 * handling GET requests on element level (retrieve element details).
 * 
 * @param service   The service name.
 * @param resource  The resource name.
 */
const elementGET = (service:Service, resource:Resource) => {
  let elementPath = pathof(BASEURI, service, resource) + "/:id";
  if(resource.getElement) { logger.info("GET   ", elementPath, "registered") };
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {

    if(!resource.getElement) {
      res.status(501).send("Not Implemented");
      return;
    }

    // proprietary element fetching
    let element = resource.getElement(req.params.id);
    if(element){
      let data = element.getValue().data;
      // filter the result before responding if needed
      if (req.query.hasOwnProperty("$fields")) {
        data = filterByKeys(data ,["id", "name", "uri"].concat(req.query["$fields"].split(",")));
      }
      //respond
      res.status(200);
      res.json({
        status: "ok",
        data: data
      });
    }
    else {
      res.status(404).send();
    }
  };
};


/**
 * handling GET requests on resource level (element listing).
 * 
 * @param service   The service name.
 * @param resource  The resource name.
 */
const resourceGET = (service:Service, resource:Resource) => {
  let resourcePath = pathof(BASEURI, service, resource);
  if(resource.getResource ) { logger.info("GET   ", resourcePath, "registered") };
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if(!resource.getResource) {
      res.status(501).send("Not Implemented");
      return;
    }
    // get all available renderes and map their representation to JSON compatible values
    function parseNumberOrId(n:string|number):string|number {
      return (typeof n === "undefined") ? undefined : ((!isNaN(parseFloat(<string>n)) && isFinite(<number>n)) ? parseFloat(<string>n) : n.toString());
    }

    let elements = resource.getResource(parseNumberOrId(req.query.$offset), parseNumberOrId(req.query.$limit));

    if(elements) {
      let resp = elements.map((value:BehaviorSubject<Element>) => {
        return value.getValue().data;
      });
      res.status(200);
      res.json({
        status: "ok",
        data: resp
      });
      return;
    }
    else {
      res.status(404).send("Not found");
    }
  };
};

/**
 * handling POST requests on resource level (elment creation).
 * 
 * @param service   The service name.
 * @param resource  The resource name.
 */
const resourcePOST = (service:Service, resource:Resource) => {
  let resourcePath = pathof(BASEURI, service, resource);
  if(resource.createElement) { logger.info("POST  ", resourcePath, "registered") };
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if(!resource.createElement) {
      res.status(501).send("Not Implemented");
      return;
    }
  };
};

/**
 * handling DELETE requests on element level (element removal or property reset).
 * 
 * @param service   The service name.
 * @param resource  The resource name.
 */
const elementDELETE = (service:Service, resource:Resource) => {
  let elementPath = pathof(BASEURI, service, resource) + "/:id"
  if(resource.deleteElement) { logger.info("DELETE", elementPath, "registered") };
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {

    if(!resource.deleteElement) {
      res.status(501).send("Not Implemented");
      return;
    }
    // proprietary element deletion
    let succeeded = resource.deleteElement(req.params.id);

    // respond
    if(succeeded){
      res.status(200);
      res.json({
        status: "ok"
      });
      return;
    }
    else {
      res.status(500).send();
      return;
    }
  };
};


/**
 * handling POST requests on element level (modify an existing element).
 * 
 * @param service   The service name.
 * @param resource  The resource name.
 */
const elementPOST = (service:Service, resource:Resource) => {
  let elementPath = pathof(BASEURI, service, resource) + "/:id"
  if(resource.updateElement) { logger.info("POST  ", elementPath, "registered") };
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {

    // find the element requested by the client
    let element = resource.getElement(req.params.id);
    if (element){
      if(resource.updateElement(req.params.id, req.body)) {
        res.status(200);
        res.json({
          status: "ok"
        });
      }
      else {
        res.status(500).send();
      }
    }
    else {
      res.status(404).send("Not Found");
    }
  };
};

/**
 * handling incoming websocket messages
 * 
 * @param service   The service name.
 * @param resource  The resource name.
 * @param ws        The WebSocket the client is sending data on.
 */
const handleWebSocketMessages = (service:Service, resource:Resource, ws:WebSocket) => {
  var _viwiWebSocket = new viwiWebSocket(ws);
  return (message:string) => {
    let msg:viwiClientWebSocketMessage;
    // make sure we actually parse the incomming message
    try {
      msg = JSON.parse(message);
    }
    catch(err) {
      _viwiWebSocket.error(400, new Error(err));
      return;
    }
    switch (msg.type) {
      case "subscribe":
        let captureGroups = msg.event.match(URIREGEX);
        if (!captureGroups) {
          _viwiWebSocket.error(400, new Error("event url malformed"));
          break; //leave immediately if 
        }
        else
        {
          let serviceName = captureGroups[1].toLowerCase();
          let resourceName = captureGroups[2].toLowerCase();
          let elementId = captureGroups[3];

          // check if  processing needed at all
          if ((service.name.toLowerCase() === serviceName) && (resource.name.toLowerCase() === resourceName)) {
            if (elementId && resource.elementSubscribable) {
                // this is an element subscription
                let element = resource.getElement(elementId);
                if (element) {
                  logger.debug("New element level subscription:", msg.event);
                  _viwiWebSocket.subscribeAck(msg.event);
                  element.takeUntil(unsubscriptions.map(topic => {topic === msg.event}))
                  .subscribe(
                  (data:Element) => {
                    _viwiWebSocket.data(msg.event, data.data);
                  },
                  (err:any) => {
                    _viwiWebSocket.error(500, new Error(err));
                  });
                }
                else {
                  _viwiWebSocket.error(404, new Error("Not Found"));
                }
            }
            else if (elementId && !resource.elementSubscribable)
            {
              _viwiWebSocket.error(503, new Error("Not Implemented"));
            }
            if (!elementId && resource.resourceSubscribable) {
              // resource subscription
              logger.debug("New resource level subscription:", msg.event);
              _viwiWebSocket.subscribeAck(msg.event);
              resource.change.takeUntil(unsubscriptions.map(topic => {topic === msg.event}))
              .subscribe(
              (data:ResourceUpdate) => {
                //@TODO: needs rate limit by comparing last update timestamp with last update
                let elements = resource.getResource(/*parseNumberOrId(req.query.$offset), parseNumberOrId(req.query.$limit)*/);
                _viwiWebSocket.data(msg.event, elements);
              },
              (err:any) => {
                _viwiWebSocket.error(500, new Error(err));
              });
            }
            else if (!elementId && !resource.resourceSubscribable)
            {
              _viwiWebSocket.error(503, new Error("Not Implemented"));
            }
          }
        }
        break;

      case "unsubscribe":
        logger.debug("Unsubscription:", msg.event);
        unsubscriptions.next(msg.event);
        _viwiWebSocket.unsubscribeAck(msg.event);
      break;
      case "reauthorize":
      default:
        _viwiWebSocket.error(501,new Error("Not Implemented"));
        break;
    }
  };
};


/**
 * helper for generating a route string
 * 
 * @param service   The service name.
 * @param resource  The resource name.
 * @returns         The combined path use as a route.
 */
function pathof(baseUri: string, service:Service, resource:Resource) {
  return baseUri + service.name.toLowerCase() + "/" + resource.name.toLowerCase();
}


/**
 * filters an object by keys
 * 
 * @param inputObject   the input object
 * @param keep          an array of strings (keys) to keep
 * @returns             the filtered object
 */
function filterByKeys(inputObject:any, keep:string[]):Object {
  if (! Array.isArray(keep) || keep.length === 0) return inputObject;
  let result:any = {};
  for (var i = 0, len = keep.length; i < len; i++) {
    let key:string = keep[i];
    if (inputObject.hasOwnProperty(key)) {
      result[key] = inputObject[key];
    }
  }
  return result;
};

export {server, run, pathof}