# Setting up the sync Worker

This is all done in Cloudflare's website. No command line, no installing anything.
Budget about 15 minutes. Everything here is on the free plan.

Cloudflare renames its dashboard menus every so often, so treat the menu names
below as "look for something like this" rather than exact labels.

## 1. Make a free Cloudflare account

Go to <https://dash.cloudflare.com/sign-up>. Email and password, confirm the
email, done. You do **not** need to add a domain, and you do **not** need a card.

## 2. Make the storage box (a "KV namespace")

KV is just a place to keep a lump of data under a name. Ours will hold one lump:
your encrypted tracker.

1. In the left sidebar find **Storage & Databases** → **KV**.
2. Click **Create a namespace** (or **Create**).
3. Name it exactly: `plan-sync`
4. Create.

## 3. Make the Worker

A Worker is a small program Cloudflare runs for you when a web address is hit.

1. Left sidebar → **Compute (Workers)** or **Workers & Pages**.
2. **Create** → **Start with Hello World!** (or **Create Worker**).
3. Name it exactly: `plan-sync`
4. **Deploy**. It deploys a placeholder — that is expected, we replace it next.

## 4. Paste in the real code

1. On the Worker's page click **Edit code** (or **< > Edit code**).
2. Select everything in the editor and delete it.
3. Open `worker.js` from this folder, copy the whole file, paste it in.
4. Click **Deploy** (top right), then **Save and deploy** if it asks.

## 5. Connect the Worker to the storage box  ← the step people get wrong

The code says `env.PLAN`. Cloudflare only knows what `PLAN` means if you tell it.

1. Back on the Worker's page → **Settings** → **Bindings**
   (older dashboards: **Settings** → **Variables** → **KV Namespace Bindings**).
2. **Add binding** → choose **KV namespace**.
3. **Variable name**: `PLAN` — capital letters, exactly that, no quotes.
4. **KV namespace**: pick `plan-sync`.
5. **Deploy** / **Save**.

> If the variable name is anything other than `PLAN`, every request fails with a
> 500 error. This is the single most common mistake. Check it twice.

## 6. Get your URL

On the Worker's overview page there is an address like:

    https://plan-sync.YOUR-SUBDOMAIN.workers.dev

`SOMETHING` is a subdomain Cloudflare picked for your account. Copy the whole
address and hand it back to me — that is all I need to wire up the page.

## 7. Check it works

Visit this in a browser, using your own address:

    https://plan-sync.YOUR-SUBDOMAIN.workers.dev/s/00000000000000000000000000000000

You should see **nothing stored** on a white page. That is the correct answer —
it means the Worker ran, found the storage box, and truthfully reported that the
box is empty. Anything else means something above went wrong:

| What you see              | What it means                                          |
|---------------------------|--------------------------------------------------------|
| `nothing stored`          | Working correctly. Move on.                             |
| `bad sync id`             | You mistyped the zeros. Needs 32-64 hex characters.     |
| `no such route`           | You left off the `/s/` part of the address.             |
| An error page / `500`     | The KV binding is missing or misnamed. Redo step 5.     |
| Cloudflare "not found"    | The Worker did not deploy. Redo step 4.                 |

## What this thing can and cannot see

It cannot read your numbers. The page encrypts them with your passphrase before
they leave the device, so KV holds bytes that look like static. Cloudflare, and
anyone who ever got hold of the storage box, would see the same static.

It also cannot be found by guessing. Your sync id is a long random string, and
the address without it returns nothing.

What it *can* do, if someone somehow had your sync id, is overwrite or destroy
the blob. They still could not read it. That is why the manual backup box in the
plan stays exactly where it is — keep using it now and then.

## Free plan limits

100,000 Worker requests and 100,000 KV reads per day, 1,000 KV writes per day.
You will use a handful per month.

---

## A note on this file

The Worker address is written as `YOUR-SUBDOMAIN` above rather than the real one.
A `workers.dev` address contains the Cloudflare account name it was created
under, and this repository is public — so the real address is deliberately kept
out of it, and out of the app's unencrypted shell. It lives inside the encrypted
plan, where reading it requires the passphrase anyway.

Nothing breaks if the address leaks: the Worker only ever holds ciphertext, and
the sync id needed to address a blob is 128 bits derived from your passphrase.
It is kept quiet for the same reason the app's key names are neutral — a public
file should not say who you are or what the blob is about.
