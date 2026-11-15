# Email alerts

People can subscribe to provinces or cities/regencies and get an email when a month's fire
activity there becomes unusual for that time of year. The code is `src/backend/app/alerts/`.

## Subscribing

1. On the dashboard, **Alerts** (shown only when the server has alerts set up) opens a form: an
   email address and up to 10 provinces or cities/regencies, starting from the areas selected on
   the dashboard.
2. The server emails a confirmation link. Until it is used, nothing else is sent to that address.
   The link opens a page with a **Confirm** button, so a mail scanner that opens links cannot
   confirm on the person's behalf. Unconfirmed sign-ups are deleted after 48 hours.
3. Every alert carries an unsubscribe link, and mail clients' one-click unsubscribe (RFC 8058) works
   too. Unsubscribing deletes the address and everything sent to it.

Subscribing again with the same address changes its regions once the new confirmation link is used.
The answer to a sign-up is the same whether or not the address was known, so the form does not
reveal who subscribed.

**Abuse limits:** a hidden form field that form-filling bots fill in, at most 5 sign-ups per client
every 10 minutes, and at most one confirmation email per address every 10 minutes.

**What is kept:** the address, its regions and the sign-up dates, under `data/alerts/subscribers/`,
and which alerts it was sent, under `data/alerts/sent/`. File names are keyed hashes of the
address. Nothing else is stored.

## When an alert is sent

After each data update (`python -m app update`, hourly on Google Cloud), every region someone
follows is scored for the month of the last data day, with the method of the dashboard's anomaly
card ([anomaly.md](anomaly.md)): the month so far, against the same days of the same month in every
other year of the record since 2002. In the first three days of a month the month before is scored
as well, so an anomaly that appeared in its last days is still reported.

A region triggers an alert when:

- its label is **anomalous** or higher (with `ALERTS_MIN_LABEL=elevated`, from **elevated**);
- for a month still in progress, at least **7 days** of it are in the record; and
- the month holds at least **5 hotspots**. In a place that rarely burns, one or two detections
  already rank above most years, which is not worth an email.

**Never twice:** a subscriber gets an alert at most once per region and month, again only if the
label rises, and at most once per region every 7 days. All of one subscriber's alerts from one run
go in one email. An alert is recorded only once its email was sent, so a failed send is tried
again on the next run.

The run happens after every update, also when no new data arrived, so a new subscriber hears about
an anomaly already under way within the hour.

## What an email says

Each region gets a short paragraph: the label, the days compared, the hotspots against the other
years and their median, the fire radiative power, the caution for places that rarely burn when it
applies, and a link to the dashboard set to that region and month. A footer explains the method
and its limits. Example, from the replay of 2015 below:

```
Subject: Fire alerts: unusual fire activity in 3 of your regions

Unusual fire activity was detected in the regions you follow.

Central Kalimantan: fire activity in July 2015 is anomalous (1-7 July, the month is not over yet).
  115 hotspots (Aqua MODIS-equivalent), more than in 12 of the 12 other years on record over the
  same days of July (median 20.4).
  Fire radiative power: 2,932 MW (anomalous).
  On the map: https://.../dashboard/?area=idn-central-kalimantan&from=2015-07-01&to=2015-07-07

South Sumatra: ...
West Kalimantan: ...

How this works: each month is compared with the same days of the same month in every other year
of the NASA FIRMS record since 2002 (MODIS and VIIRS satellites, harmonised). "Anomalous" means
the month ranks in the top tenth of the years on record for that month. The thresholds are
provisional, the satellites miss fires under cloud, and this is a record of observed fire, not a
fire danger forecast.

Unsubscribe: https://.../api/alerts/unsubscribe?token=...
```

In 2015 only the years before it were on record, hence 12 other years; today a month is compared
with about 24.

## Evidence on past seasons

`python -m app alerts --replay FROM:TO --regions ...` steps the last data day through past dates as
if each were the newest, with an imaginary subscriber, and writes the emails that would have gone
out to the outbox. Replayed day by day for Riau, South Sumatra, Jambi, Central, West and South
Kalimantan and Bali:

| Season | Alerts | Emails | What fired |
|---|---:|---:|---|
| June-November 2015 | 16 | 11 | July to November across Sumatra and Kalimantan, the El Niño peat-fire year |
| June-November 2019 | 4 | 3 | September in Riau, West Kalimantan and Jambi; October in Jambi |
| June-November 2023 | 4 | 4 | May and June in South Kalimantan; September and October in Bali, with the note for places that rarely burn |

- No region was alerted twice for the same month.
- In 2019, Central Kalimantan and South Sumatra stay below **anomalous**: their September was
  large but not in the top tenth of their years, as the dashboard's anomaly card also shows.
- Without the 5-hotspot floor, Bali would also have been alerted in 2015 and 2019 for months with
  0.1 to 0.6 hotspots, about one or two detections.

The tests (`tests/test_alerts.py`) cover the same rules on a synthetic record: one email for an
anomaly, none on the next run, one more when the label rises, nothing for a month too young or too
small, a failed send tried again, and the subscribe, confirm and unsubscribe flow.

## Setting it up

Alerts are off until `ALERTS_SECRET` is set. The settings, from the environment or `.env`:

| Setting | Meaning |
|---|---|
| `ALERTS_SECRET` | Signs the confirm and unsubscribe links; any long random string |
| `ALERTS_FROM` | Sender, for example `Bara fire alerts <alerts@your-domain>` |
| `PUBLIC_URL` | Address of the website, for the links in the emails |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` | The provider's SMTP server: port 587 with STARTTLS, or 465 with TLS |
| `ALERTS_OUTBOX` | Folder the emails are written to when no SMTP server is set (default `data/alerts/outbox`) |
| `ALERTS_MIN_LABEL` | `anomalous` (default) or `elevated` |

Any provider with SMTP works. A transactional email service (for example Brevo or Resend, which
have free tiers) delivers better than a personal mailbox; add the DNS records it asks for at the
domain's registrar so the sender address is verified.

On Google Cloud both the website service (which sends the confirmation emails and writes the
subscriptions) and the updater job (which sends the alerts) need the settings, and the website
service needs the bucket mounted writable for its user (mount option `uid=10001;gid=10001`), since
subscriptions are kept in the bucket. Keep `ALERTS_SECRET` and `SMTP_PASSWORD` in Secret Manager.

## Limits

- The thresholds are uncalibrated, as for the anomaly card ([anomaly.md](anomaly.md)).
- Alerts follow the data: hourly at best, and a day joins the record only once fully delivered.
- Clouds and smoke hide fires from the satellites, so a burning month can be missed.
- An email can land in spam until the sender's domain is verified with the provider.
