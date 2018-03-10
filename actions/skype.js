/**
 * Copyright 2018 Loïc Chacornac, Roger Miret, Valentin Viennot
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and limitations under the License.
 */

const request = require('request');

var response;
var context;


function requestConverse(args) {
    return new Promise(function(resolve, reject) {
        var payload = {
            cftoken: args.CF_TOKEN,
            filter: 'by_skype_id',
            value: context.skype_id,
            context: context,
            text: args.text
        };
        var options = {
            url: args.CF_API_BASE+'converse',
            body: payload,
            headers: {'Content-Type': 'application/json'},
            json: true
        };
        function owCallback(err, response, body) {
            if (err) {
                console.log(err);
                reject("Error calling converse.");
            } 
            else if (response.statusCode < 200 || response.statusCode >= 300 || !body || body.cftoken != args.CF_TOKEN) {
                console.log("CF call failed: ", response.statusCode);
                reject("Converse call failed.");
            } 
            else {
                console.log("CF call sucess: ", response.statusCode);
                resolve(body.response);
            }
        }
        request.post(options, owCallback);
    });
}


function getToken(args) {
	// TODO ne pas redemander un token à chaque fois (redis avec id app et time 3600 sinon redemande)
	return new Promise(function(resolve, reject) {
		var payload = {
			headers: {
				'Content-Type': 'application/json; charset=utf-8',
				'Host': 'login.microsoftonline.com'
			},
			url: "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token",
			method: 'POST',
			form: {
			  'grant_type': 'client_credentials',
			  'client_id': args.MSAPPID,
			  'client_secret': args.MSSECRET,
			  'scope': 'https://api.botframework.com/.default'
			}
		};
		request(payload, function(error, res, body) {
			var b = JSON.parse(body);
			if (b.access_token) {
				resolve(b.access_token);
			} else {
				reject(error);
			} 
		});
	});
}

function postMessageArray(response) {
	console.log("DEBUG responses: ",response);
	if (response.length<=0) return new Promise(function(resolve,reject){resolve();});
	return postMessage(response[0])
		.then(() => postMessageArray(response.slice(1)))
		.catch(err => {console.log("Error: ",err);postMessageArray(response.slice(1));});
}

function postMessage(text) {
  return new Promise(function(resolve, reject) {
  	if (text.substr(0,5)==="https") {
  		response.json.attachments = [{
            contentType : "image/"+text.substr(-3),
            contentUrl: text
		}];
        delete response.json.text;
	} else {
        response.json.text = text;
        delete response.json.attachments;
	}
	response.timestamp = (new Date()).toISOString();
    request(response, function (error, res, body) {
      if (error)
        reject(error);
      else {
		resolve(body);
	  }
    });
  });
}

function processSkypeRequest(args,token) {
	return new Promise(function(resolve,reject) {
		response.headers.Authorization = "Bearer "+token;
		response.json.from = args.recipient;
		response.json.recipient = args.from;
		response.json.conversation = args.conversation;
		//response.json.replyToId = args.id;
		response.url = args.serviceUrl+`v3/conversations/${args.conversation.id}/activities`;///${args.id}
		context.skype_id = args.from.id;
		if(args.from.name) context.username = args.from.name;
		context.skype_conversation = args.conversation.id;
		resolve();
	}); 
}

function main(args) {
	// TODO secure provenance
	if (args.type && args.text && args.from && args.recipient && args.conversation) {
        if (args.type === "add")
            return {statusCode: 200};
        else if (args.type !== "message")
        	return {statusCode: 400};
        response = {
            method: "POST",
            headers: {
                'Content-Type': 'application/json; charset=utf-8'
            },
            json: {
                "type": "message",
                "from": {},
                "conversation": {},
                "recipient": {},
                "text": "",
                //textFormat: 'xml',
                "locale": 'fr-fr',
                //"replyToId": "",
                "timestamp": ""
            }
        };
        context = {};
        var tmp = getToken(args)
            .then((token) => processSkypeRequest(args,token))
            .then(() => requestConverse(args))
            .then(ress => postMessageArray(ress))
            .catch(err => console.log("error: ",err));
        return (tmp);
	} else {
		return {statusCode:401};
	}
}

