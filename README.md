# Mailchimp sender Lambda function

Function for automatically triggering an email from Mailchimp based on an RSS feed.

> Note: This function doesn't check the RSS feed itself, that needs to be handled separately.

## How does it work?

When triggered, the function will create a campaign in Mailchimp for a defined mailing list. It will then assign a template to the campaign, and afterwards trigger a send action.

The entire process assumes that the template assigned will read its data from an RSS feed, as otherwise it will only try to send the same email over and over again. You will also need to provide the title/subject of the email when you trigger it.

## Why?

Mailchimp has built-in functionalities for RSS feeds. However, these will only send an email once a day (or week/month) at a set time. As I only post infrequently (usually once or twice a week), making people wait for the email for a day because I posted it a little later than usual is silly. Therefore I use this to trigger the email immediately after the article is available.

## Configuration

The code for the function is simple, and has no external dependencies so you can copy-paste it in if you want or add it to a zip file.

The function uses environment variables for the details, you will have to add these to your Lambda function's configuration.

* APIKEY: Your Mailchimp API key
* HOSTNAME: The hostname where your API calls should go to (in the form usX.api.mailchimp.com, where usX is the endpart of your API key)
* TEMPLATE_ID: The ID of the template you want to assign to the campaign
* LIST_ID: The ID of the recipients list
* SENDER_NAME: The name of the sender of your campaign
* REPLY_TO: The reply-to address of your campaign
* TOKEN: A security token that needs to be provided (and matched) by the trigger. This is a security measure to prevent accidental or unauthorised use.

### Trigger

The trigger will need to send 2 things to the mailsender:

* title: The title/subject of the campaign
* token: A security token that needs to match the value in the

## About the code

It's not the best looking code, and I have no doubt that someone with more knowledge of NodeJS can do a better job. It works however, and I deliberately refrained from using anything that isn't included by default in Lambda.
