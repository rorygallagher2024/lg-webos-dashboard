# What LG's ACR does

Automatic content recognition (ACR) is how an LG TV works out what is being
watched on it. This page sets out what LG and its advertising arm say the data
is for, what the firmware on the tested TVs shows, and which Glasshouse
controls act on it. Claims are LG's own unless marked otherwise.

## Who receives it

LG Ad Solutions, formerly Alphonso, is LG's majority-owned advertising
business. Alphonso ran ACR for LG before the takeover, and its servers
(`prov-lg.alphonso.tv`, `eulacheck.alphonso.tv`) are still the ones the
firmware contacts to set ACR up. LG Ad Solutions advertises reach across
49 million addressable TVs in the US and 216 million worldwide
([factsheet](https://lgads.tv/exclusive-factsheet/)).

## What it recognises

LG Ad Solutions describes its ACR as measuring viewing "at the glass level":
programmes, films, ads, games and streaming apps as they appear on the TV,
across broadcast and streaming ([technology](https://lgads.tv/technology/)).

LG's own statement of 12 September 2026 is narrower. It says ACR uses audio
fingerprinting, collects no screenshots or recordings, and runs on live TV,
HDMI inputs and LG Channels but not inside third-party apps such as Netflix
or YouTube
([statement](https://www.lg.com/us/newsroom/corporate/statement-understanding-privacy-on-lg-smart-tvs)).
The statement followed an investigation by Gamers Nexus and Level1Techs,
which reported ACR fingerprinting both audio and video, including HDMI
sources ([summary](https://tbreak.com/lg-smart-tv-privacy-gamers-nexus/)).

On the B8 (webOS 4.4, firmware 05.50.70) the ACR client, `acr2`, contains
both an audio capture path and a video capture path that can read the
displayed picture or the incoming source, and its service reports a video
capture status and speed. The statement does not say which models or
firmware its description covers.

## What it is used for

LG Ad Solutions lists the audiences advertisers can buy from ACR data
([technology](https://lgads.tv/technology/)):

* viewers of particular shows, networks, apps, services and genres;
* the devices and pay-TV or streaming services a household uses, loyalty to
  them, and when it subscribes or cancels;
* which games consoles and titles are played;
* how much TV is watched, including light and heavy viewers, cord cutters and
  ad skippers;
* region, city and ZIP code;
* which ads have already been seen, and how often.

It also offers to reach "the connected LG household beyond the TV" on phones,
tablets and computers, and to measure campaigns by reach, frequency,
attribution and brand lift ([solutions](https://lgads.tv/solutions/)). Neither
page says how a TV is linked to other devices. Industry practice is to match
on the shared home IP address
([AdExchanger](https://www.adexchanger.com/ad-exchange-news/the-marketers-guide-to-acr-tech-in-smart-tvs/)).
LG's statement says that sharing for interest-based and cross-device
advertising needs consent beyond the Viewing Information Agreement.

## What controls it

ACR is off until the Viewing Information Agreement is accepted. Several
agreement flags decide whether it runs and what its data may be used for;
the Privacy tab lists each under a descriptive name:

| Flag in the Privacy tab | Controls |
| --- | --- |
| Screen content recognition | ACR itself |
| Screen recognition (GDPR consent) | the EU consent record for ACR |
| Screen recognition (master consent) | read, with personalised advertising, by the service that places ads over live TV |
| Ads based on what you watch | using recognised content to choose ads |
| Sharing viewing data with data partners | LG and Alphonso passing viewing and device data to other companies |
| Personalised advertising | interest-based ads |

Switching the flags off stops the TV acting on them. The ad blocker's **Ads &
telemetry** mode also blocks the Alphonso servers LG Ad Solutions runs ACR through, so a TV
that still has a flag on, or re-enables one after a firmware update, has
nowhere to send the data.
