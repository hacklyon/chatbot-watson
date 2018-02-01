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

// TODO DEBUG TODO DEBUG
const MIN_CONFIDENCE = 0.5;

// Services
var conversation;
var redisClient;
var usersDb;

// Data
var context;
var user_id;
var user_rev;
// output
var response = {
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
    conversation = new Conversation({
        'username': args.CONVERSATION_USERNAME,
        'password': args.CONVERSATION_PASSWORD,
        'version_date': '2017-05-26',
        'url' : args.CONVERSATION_API_URL
    });
    console.log("Watson Conversation connected.");

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
                        context: {}
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

function getSessionContext(name) {
    console.log("Getting context from Redis (",(user_id+name),")");
    return new Promise(function(resolve, reject) {
        // Cached context
        redisClient.get((user_id+name), function(err, value) {
            if (err) {
                console.error(err);
                reject("Error getting context from Redis.");
            } else {
                var ctx = value ? JSON.parse(value) : {};
                for (var attr in context) {
                    if (context.hasOwnProperty(attr)) {
                        ctx[attr] = context[attr];
                    }
                }
                resolve(ctx);
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

function setSessionContext(name) {
    console.log("Setting context to Redis (",user_id+name,")");
    if (context) {
        const newContextString = JSON.stringify(context);
        // Saved context will expire in 600 secs.
        redisClient.set(user_id+name, newContextString, 'EX', 120);// TODO increase this time when we will be able to clear cache on shouldendsession
    }
}

function setUserDocument(persisted_attr) {
    console.log("Saving new context to Cloudant (",user_id,")");
    return new Promise(function(resolve,reject) {
        // Context to save : which attributes to persist in long term database
        var cts = {};
        persisted_attr.forEach(attr => {
            if (context[attr])
                cts[attr] = context[attr];
        });
        // Persist it in database
        usersDb.insert({
            _id: user_id,
            _rev: user_rev,
            type: 'user-context',
            context: cts
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
                outputs.forEach(output => {
                    // excluse outputs without text
                    output.confidence = output.output.text.length > 0 ? 
                        Math.max(
                            output.intents[0] ? output.intents[0].confidence : 0,
                            output.entities[0] ? output.entities[0].confidence : 0
                        ) : -1;
                    // more chances to stay in same ws than last used
                    if (context.LAST_WS_USED && output.ws_name && output.ws_name === context.LAST_WS_USED)
                        output.confidence += 0.1;// TODO better
                    console.log("confidence ",output.ws_name,": ",output.confidence);
                });
                // select more confident output
                var output = getMoreConfidentOutput(outputs);
                if (!output)
                    rejectall("No output from WCS.");
                else {
                    // save context
                    if (output.ws_name)
                        context.LAST_WS_USED = output.ws_name;// TODO better
                    if (output.context)
                        context = output.context;
                    setSessionContext(output.ws_name);
                    resolveall(output);
                }
            })
            .catch(err => rejectall(err));
    });
}

function addRequest(input_text, names, workspaces, requests) {
    if (names.length<=0) return new Promise(function(resolve,reject) {resolve(requests)});
    return getSessionContext(names[0])
        .then((ctx) => {
            requests.push(new Promise(function(res, rej) {
                conversation.message(
                    {
                        workspace_id: workspaces[names[0]],
                        context: ctx,
                        input: {
                            'text': input_text
                        }
                    }, function(err, output) {
                        if (err) {
                            console.log(err);
                            rej("Error asking Watson.");
                        } else {
                            console.log("answer from ",names[0]," : ",JSON.stringify(ctx));
                            output.ws_name = names[0];
                            res(output);
                        }
                    }
                );
            }));
        })
        .then(() => addRequest(input_text, names.slice(1), workspaces, requests));
}

function prepareRequests(input_text, args) {
    const workspaces = JSON.parse(args.WORKSPACES);
    var names = [];
    for (var ws in workspaces) {
        names.push(ws);
    }
    return addRequest(input_text,names,workspaces,[]);
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
    return max_c < MIN_CONFIDENCE ? last_o : max_o;
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
    if (args.cftoken && args.cftoken === args.CF_TOKEN && args.text) {
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