'use strict';

/*jshint esversion: 6 */

/**
 * Lambda function for creating an automated campaign in Mailchimp.
 * This requires that you have set up a Mailchimp template that scans your RSS feed or some other way to retrieve the latest information.
 * It does the following in order:
 * 1. Create a campaign
 * 2. Assign a template to the campaign`
 * 3. Send the campaign
 *
 * The function makes use of a number of environment variables that you'll have to set in your function:
 * APIKEY: Your mailchimp API key
 * HOSTNAME: The hostname where your API calls should go to (in the form usX.api.mailchimp.com, where usX is the endpart of your API key)
 * TEMPLATE_ID: The ID of the template you want to assign to the campaign
 * LIST_ID: The ID of the recipients list
 * SENDER_NAME: The name of the sender of your campaign
 * REPLY_TO: The reply-to address of your campaign
 *
 * Additionally, it will check event.title for the title/subject of the campaign so this needs to be provided.
 */

const https = require('https');

/*
 * Trigger a send for the campaign
 */
function SendCampaign(campaign_id) {
  var options = {
    hostname: process.env.HOSTNAME,
    port: 443,
    path: '/3.0/campaigns/' + campaign_id + '/actions/send',
    method: 'POST',
    auth: 'anyuser:' + process.env.APIKEY,
  };

  const req = https.request(options, (res) => { });
  req.end();
}

/**
 * Set the template for the campaign
 */
function UpdateCampaign(campaign_id) {
  var template_body = {
  	"template": {
  		"id": parseInt(process.env.TEMPLATE_ID)
  	}
  };

  var options = {
    hostname: process.env.HOSTNAME,
    port: 443,
    path: '/3.0/campaigns/' + campaign_id + '/content',
    method: 'PUT',
    auth: 'anyuser:' + process.env.APIKEY,
    headers: {
        "Content-Type": "application/json",
        'Content-Length': Buffer.byteLength(JSON.stringify(template_body))
    }
  };
  const req = https.request(options, (res) => {
    let updated_body = '';
    res.setEncoding('utf8');
    res.on('end', () => {
      SendCampaign(campaign_id);
    });
  });
  req.write(JSON.stringify(template_body));
  req.end();
}

/**
 * Create the Mailchimp campaign
 */
function CreateCampaign(event, callback) {
    var create_body = {
    	"type": "regular",
    	"recipients": {
    		"list_id": process.env.LIST_ID
    	},
      "settings": {
    		"subject_line": event.title,
    		"title": event.title,
    		"from_name": process.env.SENDER_NAME,
    		"reply_to": process.env.REPLY_TO,
    		"inline_css": true
    	}
    };

    var options = {
      hostname: process.env.HOSTNAME,
      port: 443,
      path: '/3.0/campaigns/',
      method: 'POST',
      auth: 'anyuser:' + process.env.APIKEY,
      headers: {
          "Content-Type": "application/json",
          'Content-Length': Buffer.byteLength(JSON.stringify(create_body))
      }
    };

    const req = https.request(options, (res) => {
        let created_body = '';
        console.log('Status:', res.statusCode);
        console.log('Headers:', JSON.stringify(res.headers));
        res.setEncoding('utf8');
        res.on('data', (chunk) => created_body += chunk);
        res.on('end', () => {
            console.log('Successfully processed HTTPS response');
            if (res.headers['content-type'] === 'application/json; charset=utf-8') {
                console.log("It's JSON");
                created_body = JSON.parse(created_body);
                UpdateCampaign(created_body.id);
            }
            callback(null, created_body);
        });
    });
    req.on('error', callback);
    req.write(JSON.stringify(create_body));
    req.end();
}

exports.handler = (event, context, callback) => {
  CreateCampaign(event, callback);
};
