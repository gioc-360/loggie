Do not call any tools. Everything you need is in this prompt. Answer with JSON Lines only: one JSON object per line, no prose, no code fences.

# Job

You write test sentences for Loggie, a Mac app with one text box. People type one sentence and Loggie fills an invite in Outlook, or a text in Messages or WhatsApp, or an email reply in Outlook. It never sends. Your sentences test the code that reads the box, so each one comes with the answer the code must reach.

Write {{COUNT}} sentences for the action **{{ACTION}}**, in the style **{{ROUND}}**.

{{ROUND_TEXT}}

# The people Loggie knows (use only these; never invent a person)

| Full name | Where they are |
|---|---|
| Lena Ortiz | Messages, WhatsApp, Outlook |
| Jamie Chen | Messages, Outlook |
| Yuki Tanaka | WhatsApp, Outlook |
| Marisol Reyes | Messages, Outlook |
| Tomas Berg | Outlook |
| Ilona Varga | Outlook (two email addresses, still one person) |
| Sam Lee | Messages, Outlook |
| Sam Patel | Messages, Outlook |

People refer to them by first name ("lena"), full name ("lena ortiz"), lowercase, or with a typo of one letter in a first name of five letters or more ("marisl"). There are two Sams: when you write a Sam, always write the full name ("sam lee", "sam patel").

Places people have used before: Maplewood, Birch Hall, Statler, Ashbury, Elm Hall, Collegetown Bagels. A place may also be any other place said after "at", "in" or "@".

Today is Monday, October 12, 2026, 9:00 AM.

# What each action means

- **invite**: a calendar invite in Outlook (or Google Calendar when the sentence says google). Who is invited, when, where, what it is about. Words: invite, schedule, book, meet, set up, or just the kind of event ("lunch with lena friday").
- **text**: a message in Messages (iMessage). Words: text, message, msg, imessage, tell, ask, ping, let X know. The sentence carries the words the person will read.
- **whatsapp**: a message in WhatsApp. Words: whatsapp, wa, or "text X on whatsapp".
- **email**: Loggie writes a reply in that person's latest email thread in Outlook. Words: email, mail, "email X back". The sentence carries what the reply should say.

# The answer for each sentence

One JSON object per line with exactly these keys:

```
{"sentence": "...", "action": "invite|text|whatsapp|email", "who": ["Full Name", ...], "app": "outlook|google|messages|whatsapp", "day": null, "time": null, "minutes": null, "where": null, "about": null, "kind": null, "message": null}
```

- `who`: full names from the table, in the order said.
- `app`: invite is "outlook" unless the sentence says google; text is "messages"; whatsapp is "whatsapp"; email is "outlook".
- `day` (invite only, else null): "today", "tomorrow", a weekday as three letters ("fri"), "next fri" when the sentence says next, or "MM-DD" for a date ("10-14"). null when no day is said.
- `time` (invite only, else null): 24-hour "HH:MM". "5pm" is "17:00", "1730" is "17:30", "noon" is "12:00", "5:30" with no am/pm is "17:30", "at 5" with no am/pm is "17:00", "9am" is "09:00". null when no time is said.
- `minutes` (invite only, else null): the length when said ("for 30 min" is 30, "for an hour" is 60, "for 2 hours" is 120). null when not said.
- `where` (invite only, else null): the place, as written, without "at"/"in" ("Maplewood", "Birch Hall"). null when none.
- `about` (invite only, else null): the subject the invite should carry, the words after "about"/"re"/"regarding"/"on" or in quotes, or a topic said with "for" ("for the hackathon" is "the hackathon"). Without the signal word. null when none.
- `kind` (invite only, else null): one of "call", "lunch", "coffee", "dinner", "sync", "chat", "meeting", "catch-up", "1:1" when the sentence names the kind of event. null otherwise.
- `message` (text, whatsapp, email only, else null): the words the person will read, exactly as typed (keep their spelling and punctuation), without the action word, the names, "saying"/"that"/":", or "on whatsapp". For email, include any "about ..." topic as part of the message. null when the sentence has no words to send.

# Rules for the sentences

- Each sentence is something a real person would type into one box on a laptop, in their own words.
- No two sentences the same. Vary which people, how many (one to three), and which details are present.
- Only people from the table. Never a phone number or an email address.
- An invite always has at least one person. A text, whatsapp or email always has at least one person and a message.
- Keep each answer exactly right: the code is graded against it.
