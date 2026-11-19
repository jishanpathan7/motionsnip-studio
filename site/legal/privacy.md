# Privacy

> **Draft.** This page is a draft for the owner to check before launch. It is not legal advice.

<!-- Owner: check this with a lawyer for the places you sell to (for example India's DPDP Act and the EU GDPR), add
your legal name and a contact address, and confirm the hosting and log details below. -->

Short version: MotionSnip runs on your computer and has no account and no telemetry. The app sends nothing anywhere unless you use Pro, and then only your licence key and a hash of a random install ID.

## The app

MotionSnip Studio is a small server on your computer, bound to `127.0.0.1`, and a page in your browser. Your videos, music, edits, notes and feedback stay in your project folder and your browser's storage. None of it is uploaded.

The free app makes no network requests of its own: no telemetry, no analytics, no crash reports, no update checks. The tools you choose to use with it, such as Claude Code, Remotion or ffmpeg, follow their own privacy terms.

## Pro

Pro talks to the licence server at `licence.motionsnip.com` only when it needs to:

- **Activate:** when you enter your licence key.
- **Refresh:** when your licence period is about to end, so the file on your computer can be renewed. This runs in the background when the player starts.
- **Deactivate:** when you remove Pro from a device.
- **Download:** when you install or update a Pro pack.

Each request sends your licence key (or your current licence file) and a SHA-256 hash of a random install ID. The install ID is a random value MotionSnip creates on your computer the first time you activate. It isn't tied to your hardware, your name or anything else about the machine, and only its hash ever leaves your computer.

The licence server keeps, for each key, the hashes of the devices it's activated on and when each one was last activated or refreshed, so it can enforce the 3-device limit. It doesn't receive your videos, your projects, your file names or how you use the app. Like any web server, it sees your IP address while a request is being answered.

<!-- Owner: confirm whether the Worker or its host keeps request logs (IP addresses, times) and for how long. -->

## Buying Pro

Checkout is run by [Polar](https://polar.sh), the merchant of record, under Polar's own privacy policy, linked from [polar.sh](https://polar.sh). Polar and its payment processor collect what a purchase needs, such as your name, email address, billing address and payment details. MotionSnip receives your email address, your name if you give one, and your order and subscription status, to issue your licence key and answer support questions. Card details never reach MotionSnip.

## This website

motionsnip.com is a static site. It has no cookies, no analytics and no tracking scripts.

- The pages load their fonts from Google Fonts, so your browser asks Google's servers for them and Google sees your IP address. See [Google's privacy policy](https://policies.google.com/privacy).
- The site is hosted on Vercel, which keeps standard request logs, such as IP addresses and the pages asked for, to run and protect the service.
- The [live demo](/demo/) runs entirely in your browser. Nothing you do in it is sent anywhere.

## Your choices

- Don't want any network requests? Use the free app, which makes none.
- To remove a device from your licence, deactivate it in MotionSnip. To have your licence records deleted, ask through the support address on your Polar receipt. Polar handles requests about your purchase data.

## Changes

If this page changes, the new version is posted here.
