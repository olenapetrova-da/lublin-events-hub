# LEH v.2 Project Vision

The application for getting the list of events in Lublin, Poland. The user asks the bot by:

- selecting the date or period;
- selecting the category;
- selecting the payment information.

The application should select events from the database, filter according to requested categories and provide them to the user as a list .

# Current State

Project files: [https://github.com/olenapetrova-da/lublin-events-hub/tree/main](https://github.com/olenapetrova-da/lublin-events-hub/tree/main)

Release tag: [v0.3.0](https://github.com/olenapetrova-da/lublin-events-hub/tree/v0.3.0)

## Select parameters

Period: today, a week from today

Category: film, teatr

Parameters’ values are taken from the tags and labels in the sources. 

## Sources

 [lublin.eu](http://lublin.eu), zoom.lublin.pl

The source adapters and data merge/dedup are in Cloudflare Workers. Language: JavaScript.

## UI

Telegram bot

Use cases:

- start
- select period
- select category
- back

Use cases are implemented as buttons in the UI

## Database

Google Sheets

Filtering, sorting via Google Apps Script (Java Script)

## Integration

The integration via Make.com

# Target State

## Select parameters

The user specifies:

| **Parameter** | **Values examples** | **Mandatory for user request** | **Number of options in one user request** | **Presence in the source** | **Presence in the database** |
| --- | --- | --- | --- | --- | --- |
| Period | today,
the date during the week since today,
the weekend,
the week since today | yes | 1 | always | always |
| Category (the type of event) | film, theatre, exhibition, workshop, festival, market, museum | yes/no (either Category or Audience must be) | 1, 2, All | not always, may have lable of Audience or Activity type instead
(may be on the event details page) | always,
should be provided by the system in case of absence in the source |
| Audience (for whom) | kids, family, seniors, students, all | yes/no (either Category or Audience must be) | 1,2,All | not always, may have lable of Category or Activity type instead
(may be on the event details page) | always,
should be provided by the system in case of absence in the source |
| Activity type | sort, science, tech | no | 1,2, All | not always, may have lable of Category or Audience instead
(may be on the event details page) | may be empty |
| Payment | free or exact sum | no | 1 (yes or no) | always, but may be on the event details page  | always |

To add parameters an LLM capabilities may be used.

## Sources

- [lublin.eu](http://lublin.eu), zoom.lublin.pl,
- a couple of teckets aggregators (eg. [https://www.kupbilecik.pl/](https://www.kupbilecik.pl/), [https://biletyna.pl/](https://biletyna.pl/)),
- websites of local comunity centers (eg.  [https://csklublin.pl/](https://csklublin.pl/), [https://baobab.lublin.pl/kalendarz/](https://baobab.lublin.pl/kalendarz/), [https://ddkweglin.pl/](https://ddkweglin.pl/)), etc.
- websites of local expo centers (eg. [https://www.targi.lublin.pl/pl](https://www.targi.lublin.pl/pl)),
- or - facebook local events

## UI

WhatsApp or Facebook Messenger bot, if possible

In the future, several communication channels.

### Use cases:

- Start
- Request
    - Select period
    - Select Category + Audience (+ Back)
    - Select Activity type or Skip  (+ Back)
    - Select Payment or Skip  (+ Back)
- User inputs a free text - the system doesn’t have to perceive but should process and reply with some message to direct the user.
    - Optionally, the system could reply to a thank you message from the user

### System Response

- General request
    - number of events found
    - date - category/audience - title  - times - venue - payment - link to event details page
    - pagination by 10 events (it is allowed to extend 1 time)
        - proposition to narrow the request

## Database

Postgre, if possible. 

Or alternatives that better fit the functional requirements and limitations.

## Integration

n8n

## Script Language

Python, optionally JS.

# Project budget and limitations

## Budget

My app is free for the users now.

I work as a solo developer and all payments are on me. Thus, I am interested in as low budget as possible.

I have a ChatGPT Plus plan, would like to try another (eg. Claude), but it is not possible to pay for both.

I realize I need to pay for the integration tool. The payment models of Make are not suitable for this project. That’s why I want to try n8n. But it is critical to keep the costs as low as possible. 

## Business needs

I need to test the most uncertain and the most expensive solutions and features as early as possible.

I need to see the design and roadmap first and to see where we are on it during the implementation.

I need to deliver the application features to production as early as possible.