# Clarifications on Project Vision

# Volume & usage

## Events scale

Rough range of events per day / per week for 

- current sources ([lublin.eu](http://lublin.eu/), [zoom.lublin.pl](http://zoom.lublin.pl/)) : up to 150 after dedupe
- xpected extra sources (ticket sites, community centers, expo centers, etc.): it is difficult to say, but let it be up to 200

## Expected user usage

- How many bot users per day / per week? Currently I want to create the app for small amount of users, let’s say up to 50 per week
- How many requests per user (1–2 vs 10+ per session)? up to 5 per session

These numbers are for production. While developing and testing there may be much more.

# Hosting choices

please advise on better solution for both of the tools. I need to stay cheap, at the same time I wouldn’t like to get stucked in technical issues. I need to deliver quickly and there is no big number of real users for this version.

## n8n

Self-hosted (on your own VPS) vs n8n Cloud: Not sure how difficult is to make it self-hosted. I am not going to have my PC on all the time as well. So,  I expect you advise based on information about me and business specified in the project files.

## Database

- Preference: single small managed Postgres (Supabase / Render / Railway / etc.) vs Postgres on same VPS as n8n: Not sure, untill now I installed and runed Postgre on my PC via PgAdmin4 and DBeaver. What would you recommend based on information about me and business specified in the project files?
- Any **data residency** requirements: Were not in initial plan unless you say it is required to implement some functions. I wouldn’t like to get into that.

# LLM usage expectations

First I should say that it is important for me to show my experience with AI agent. To which scale - should be balanced, taking into account budgetary and other constraints. 

How far you want to go beyond v1: Just **simple buttons + filters**, or **LLM-assisted.**

- I see the limitation of just simple buttons: sources have not enough and messy categorizations of events. We will have to normalize categories and add such information as audience and Activity type (if any). As a result each event will have several lables (as described in the table in LEHv2_ProjectVision.md. I wouldn’t like to have complicated regexes.
That’s why I assule that we will be in need of LLMs and/or AI agent to enrich the event with this information. Do I understand that correctly?
- I do not presume any free text questions, That is absolutely out of scope. 
But there may occur not expected free-text writings. We should process tham to direct the user to correct way. 
Only “thank you” messages should be identified and replied accordingly.

Target **monthly LLM budget**

Currently I don’t really know what does that mean and how much I will need. I don’t know how big may be the cost for my solo project. 
I need to know the options and to be strict to my budget limitations from LEHv2_ProjectVision.md file in the Project documents.

# UI priorities

WhatsApp or FB Messenger (just one) are of bigger value for the project. But we could live for some time with Telegram to pay more attention to implementation of the beckend functionality.

# Operational constraints

- How much **manual maintenance** is acceptable: Manually fixing taxonomy for weird events - yes. Manually disabling a broken source - not sure.
- How often can you afford to do **infra chores** (upgrading n8n, DB migrations, etc.): I don’t know how often it may be required. While development and testing - it is affordable. Further depends on the frequency and complexity.