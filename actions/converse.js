/**
 * Copyright 2018 IBM All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the “License”);
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *  https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an “AS IS” BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Dependencies
const request = require('request');
const Conversation = require('watson-developer-cloud/conversation/v1');
const redis = require('redis');

// Services
var redisClient;
var usersDb;
var conversations;
var workspaces;

// Data
var context;
var user_id;
var user_rev;
var user_convs;
var user_lastconv;
// output
var response;
//input
/**
 * {
 *  cftoken: args.CF_TOKEN,
 *  // to retrieve context from db
 *  filter: 'by_id',
 *  value: 'id',
 *  // contextual informations to add to the request
 *  context: {},
 *  text: 'input_text'
 * }
 */

/**
 * Initialize services : Watson Conversation, Compose Redis, Cloudant NoSQL
 * @param args request arguments
 */
function initServices(args) {
    workspaces = JSON.parse(args.WORKSPACES);
    workspaces.forEach(ws => {
        if (ws.type === "WCS") {
            if (ws.keychain) {
                if (!conversations[ws.keychain]) {
                    var credentials = JSON.parse(args[ws.keychain]);
                    conversations[ws.keychain] = new Conversation({
                        'username': credentials.username,
                        'password': credentials.password,
                        'version_date': '2017-05-26',
                        'url' : credentials.api||"https://gateway.watsonplatform.net/conversation/api"
                    });
                    console.log("Watson Conversation connected (keychain: ",ws.keychain,").");
                }
            } else {
                console.log("WCS needs a keychain attribute! aborted.");
            }
        }
    });

    redisClient = redis.createClient(args.REDIS_URI);
    console.log("Redis Connected.");

    // connect to the Cloudant database
    var cloudant = require('cloudant')({url: args.CLOUDANT_URL});
    console.log("Cloudant connected.");

    usersDb = cloudant.use(args.USERS_DB);
    console.log("UsersDb connected.");
}

/**
 * Retrieve context from Cloudant DB and input
 */
function getContext(filter, value, persisted_attr, input) {
    return getUserDocument(filter, value)
        .then(doc => setGlobalContext(doc, persisted_attr, input));
}

/**
 * Persist context to Cloudant DB
 */
function setContext(persisted_attr) {
    return setUserDocument(persisted_attr);
}

function setGlobalContext(doc, persisted_attr, input) {
    user_convs = doc.conversations || [];
    user_lastconv = doc.LAST_CONV || null;
    var ctx = doc.context || {};
    // Persisted context
    console.log("properties from cloudant: ");
    persisted_attr.forEach(attr => {
        if (ctx[attr]) {
            context[attr] = ctx[attr];
            console.log(attr,": ",ctx[attr]);
        }
    });
    // Request context
    console.log("properties from input: ");
    for (var attr in input) {
        if (input.hasOwnProperty(attr)) {
            context[attr] = input[attr];
            console.log(attr,": ",input[attr]);
        }
    }
    return doc;
}

function getUserDocument(filter, value) {
    // TODO limit nb request call
    console.log("Getting user document from Cloudant (",filter,",",value,")");
    return new Promise(function(resolve,reject) {
        getSavedContextRows(filter, value)
            .then(rows => {
                if (rows && rows.length > 0) {
                    console.log("retrieved doc_id: ", rows[0].doc._id);
                    user_id = rows[0].doc._id;
                    user_rev = rows[0].doc._rev;
                    resolve(rows[0].doc);
                } else {
                    console.log("Creating user in Cloudant db...");
                    usersDb.insert({
                        type: 'user-context',
                        context: {},
                        conversations: []
                    }, function (err, doc) {
                        if (doc) {
                            console.log("created doc_id: ", doc.id);
                            user_id = doc.id;
                            user_rev = doc.rev;
                            resolve(doc);
                        } else {
                            console.log(err);
                            reject("Error creating document.");
                        }
                    });
                }
            })
            .catch(err => reject(err));
    });
}

function getSession(names) {
    console.log("Getting context from Redis (",names[0],")");
    return new Promise(function(resolve, reject) {
        // Cached context
        redisClient.get(names[0], function(err, value) {
            if (err) {
                console.error(err);
                reject("Error getting context from Redis.");
            } else {
                // detects inactive conversation
                if (!value && !names[1]) {
                    user_convs.splice(user_convs.indexOf(names[0]),1);
                    reject("Delete inactive conversation...");
                } else {
                    var ws = {};
                    if (names[1]) {
                        ws = names[1];
                        var temp = value ? JSON.parse(value) : {};
                        ws.context = temp.context || {};
                    } else {
                        ws = JSON.parse(value);
                        if (!ws.context) ws.context = {};
                    }
                    for (var attr in context) {
                        if (context.hasOwnProperty(attr)) {
                            ws.context[attr] = context[attr];
                        }
                    }
                    resolve(ws);
                }
            }
        });
    });
}

function getSavedContextRows(filter, value) {
    return new Promise(function(resolve,reject) {
        usersDb.view('users', filter, {
            keys: [value],
            include_docs: true
        }, function (err, body) {
            if (err) {
                console.log('Error: ',err);
                reject("Error getting saved context from Cloudant.");
            } else {
                resolve(body.rows);
            }
        });
    });
}

function setSession(origin_id,ws) {
    console.log("Setting context to Redis (",origin_id,")");
    console.log("DEBUG : ", JSON.stringify(ws));
    if (context) {
        ws.recursive = false;
        ws.context = {};
        Object.assign(ws.context, context);
        delete ws.context.action;
        const newString = JSON.stringify(ws);
        redisClient.set(origin_id, newString, 'EX', 120);
        // TODO clear cache on shouldEndSession ? 
    }
}

function setUserDocument(persisted_attr) {
    console.log("Saving new context to Cloudant (",user_id,")");
    return new Promise(function(resolve,reject) {
        // Context to save : which attributes to persist in long term database
        var cts = {};
        persisted_attr.forEach(attr => {
            if (context[attr]) {
                cts[attr] = context[attr];
                console.log("persist ",attr," value ",context[attr]);
            }
        });
        // Persist it in database
        usersDb.insert({
            _id: user_id,
            _rev: user_rev,
            type: 'user-context',
            context: cts,
            conversations: user_convs,
            LAST_CONV: user_lastconv
        }, function (err, user) {
            if (user) {
                console.log("Context persisted into Cloudant DB.");
                resolve(user);
            } else {
                console.log(err);
                reject("Error saving User.");
            }
        });
    });
}

function askWatson(input_text, args) {
    return new Promise(function(resolveall, rejectall) {
        // Prepare for asking multiple workspaces
        prepareRequests(input_text, args)
            .then(requests => {
                return Promise.all(requests);
            })
            .then(outputs => {
                // select confidence for each output
                var last_o = null;
                outputs.forEach(output => {
                    last_o = output;
                    // exclude outputs without text
                    output.confidence = output.output.text.length > 0 ? 
                        Math.max(
                            output.intents[0] ? output.intents[0].confidence : 0,
                            output.entities[0] ? output.entities[0].confidence : 0
                        ) : -1;
                    // more chances to stay in same ws than last used
                    if (user_lastconv && output.ws_origin_id && output.ws_origin_id === user_lastconv)
                        output.confidence += 0.11;// TODO better
                    console.log("confidence ",output.ws_origin_id,": ",output.confidence);
                });
                if (last_o) last_o.confidence -= 0.03;// TODO better
                // select more confident output
                var output = getMoreConfidentOutput(outputs);
                if (!output)
                    rejectall("No output from WCS.");
                else {
                    // save context
                    if (output.ws_origin_id)
                        user_lastconv = output.ws_origin_id;
                    if (output.context)
                        context = output.context;
                    setSession(output.ws_origin_id,output.ws_origin);
                    resolveall(output);
                }
            })
            .catch(err => rejectall(err));
    });
}

function addRequest(input_text, names, requests) {
    if (names.length<=0) return new Promise(function(resolve,reject) {resolve(requests)});
    return getSession(names[0])
        .then((ws) => {
            console.log("DEBUG ws : ",JSON.stringify(ws));
            requests.push(new Promise(function(res, rej) {
                conversations[ws.keychain].message(
                    {
                        workspace_id: ws.id,
                        context: ws.context,
                        input: {
                            'text': input_text
                        }
                    }, function(err, output) {
                        if (err) {
                            console.log(err);
                            rej("Error asking Watson.");
                        } else {
                            console.log("answer from ",ws.name," : ",JSON.stringify(output));
                            delete ws.context;
                            if (ws.recursive && output.context && output.context.conversation_id) {
                                output.ws_origin_id = output.context.conversation_id;
                                user_convs.push(output.context.conversation_id);
                            } else {
                                output.ws_origin_id = names[0][0];
                            }
                            output.ws_origin = ws;
                            res(output);
                        }
                    }
                );
            }));
        })
        .then(() => addRequest(input_text, names.slice(1), requests));
}

function prepareRequests(input_text, args) {
    var names = [];
    // if we have to stay on the same conversation, dont ask others
    if (context.KEEP_CONV && user_lastconv) {
        names.push([user_lastconv,null]);
        // do not loop
        context.KEEP_CONV = false;
    } else {
        // default workspaces
        workspaces.forEach(ws => {
            if (ws.type === "WCS") {
                names.push([user_id+ws.name,ws]);
            }
        });
        // active conversations
        user_convs.forEach(conv => {
            names.push([conv,null]);
        });
    }
    return addRequest(input_text,names,[]);
}

function getMoreConfidentOutput(outputs) {
    var max_c = -1;
    var max_o = null;
    var last_o = null;
    outputs.forEach(output => {
        last_o = output;
        if (output.confidence > max_c) {
            max_c = output.confidence;
            max_o = output;
        }
    });
    return max_c < 0 ? last_o : max_o;
}

function watsonResponse(watsonsaid) {
    response.statusCode = 200;
    response.body.response = watsonsaid;
    response.body.context = context;
    response.body.user_id = user_id;
    response.body.user_rev = user_rev;
    return response;
}

function interpretWatson(data, args) {
    return new Promise(function(resolve, reject) {
        var watsonsaid = [];
        if (data.output && data.output.text)
            watsonsaid = data.output.text;
        // Clear Redis cache if session ends
        if (context.shouldEndSession)
            redisClient.del(user_id);// TODO
        // Execute OW action if needed
        if (context.action) {
            var options = {
                url: args.CF_API_BASE+context.action,
                body: {
                    cftoken: args.CF_TOKEN,
                    context: context,
                    intents: data.intents,
                    entities: data.entities,
                    user_id: user_id,
                    user_rev: user_rev
                },
                headers: {'Content-Type': 'application/json'},
                json: true
            };
            console.log("Action ", context.action, ": ", options.url);
            function owCallback(err, response, body) {
                if (err) {
                    console.log("Error calling action: ", err);
                } 
                else if (response.statusCode < 200 || response.statusCode >= 300) {
                    console.log("CF action call failed: ", context.action, " ", response.statusCode);
                } 
                else {
                    console.log("CF action call sucess: ", context.action);
                    // additionnal answers
                    if (body.response) watsonsaid = watsonsaid.concat(body.response);
                }
                // After execution, delete action instruction to avoid persisting it
                delete context.action;
                resolve(watsonsaid);
            }
            request.post(options, owCallback); 
        } else {
            resolve(watsonsaid);
        }
    });
}

// What to do when action is triggered
function main(args) {
    context = {};
    conversations = {};
    workspaces = [];
    user_convs = [];
    user_lastconv = null;
    response = {
        headers: {
            'Content-Type': 'application/json'
        },
        statusCode: 500,
        body: {
            version: "1.0",
            cftoken: "",
            user_id: "",
            user_rev: "",
            response: [],
            context: context
        }
    };
    if (args.cftoken && args.cftoken === args.CF_TOKEN && args.text && args.WORKSPACES) {
        context = {};
        response.body.cftoken = args.CF_TOKEN;
        if (!args.filter) args.filter = 'by_id';
        console.log("new converse request: ", args.text);
        // Connect to services
        initServices(args);
        // Get persisted attributes
        const persisted_attr = JSON.parse(args.PERSISTED_ATTR);
        // Process request
        return getContext(args.filter,(args.value||""),persisted_attr,(args.context||{}))
            .then(doc => askWatson(args.text,args))
            .then(output => interpretWatson(output,args))
            .then(watsonsaid => watsonResponse(watsonsaid))
            .then(response => setContext(persisted_attr))
            .then(() => {
                console.log("Processed: ", response.body.response);
                return response;
            })
            .catch( err => {
                console.error('Error: ', err);
                return response;
            });
    } else if (!args.cftoken || args.cftoken != args.CF_TOKEN) {
        response.statusCode = 401;
        return response;
    } else {
        response.statusCode = 400;
        return response;
    }
}