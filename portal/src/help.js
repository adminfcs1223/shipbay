// Quick help shown at the top of every screen ("How this works"). Keyed by nav key. Plain language, written for the
// person standing at the station or the client opening the portal for the first time.
export const HELP = {
  orders: {
    title: 'Orders',
    what: 'Every order we have to ship, for every brand, sorted by the date it has to leave.',
    steps: [
      'Start on the overview: all brands, oldest deadline first. Red = late, orange = due today or tomorrow.',
      'Click an order (or a brand card) to open that brand’s orders page. Everything from here on is one brand.',
      'Sync pulls in new orders from wherever that brand’s orders live (Veeqo, Shopify or both — set under the ⚙ Order settings on the brand page). Orders also arrive on their own; Sync just catches up.',
      'Hold an order when something’s wrong (address, stock, customer question). Release it to put it back in the queue.',
      'Pack & ship → sends the order to the packing station. Packing slip prints the slip with the barcode the station scans.',
    ],
  },
  receiving: {
    title: 'Receiving',
    what: 'Checking in a brand’s inbound stock so it becomes inventory we can ship.',
    steps: [
      'Pick the brand, then the inbound (or create one: what’s coming, how, when, and the expected SKUs + quantities).',
      'Choose the SKU you’re about to count. If the units already have our 3×1 labels, scan them. If not, print a batch, stick them on, then scan.',
      'Scan one unit at a time. A scan that isn’t the chosen SKU is refused (red) so counts can’t cross. Use − / + to fix a miscount.',
      'Repeat for each SKU. The line turns green when the count matches what was expected.',
      'Set the put-away location (or scan a bin label), then Finalize. Inventory posts once; differences from the expected list are flagged for the client.',
    ],
  },
  pack: {
    title: 'Pack & Ship',
    what: 'The packing station: verify the pick, weigh the box, buy the label, print it.',
    steps: [
      'Pick the brand. The queue shows that brand’s open orders, deadline first.',
      'Scan the packing slip barcode to pull an order up (or click it). Then scan every unit — a wrong item or an extra unit is refused.',
      'When every unit is scanned, pick the packaging, confirm the weight from the scale, and Get rates.',
      'Choose a rate and Buy label & ship. The label opens for the 4×6 printer; tracking goes back to the brand’s system automatically.',
      'Label bought somewhere else? Use “Enter tracking manually”. Need an order that isn’t in the system (sample, replacement, wholesale)? Create order.',
    ],
  },
  onboarding: {
    title: 'Onboarding',
    what: 'Getting a new brand from signed quote to live, in four phases: Paperwork, Systems, Inventory, Go-live.',
    steps: [
      'Start onboarding from a website lead or by name. Each step has a circle: empty = not started, dash = received and waiting on review, check = done.',
      'Paperwork: upload the documents the brand sends; approve them under Compliance. Signature documents go out from here and come back signed.',
      'Systems: create their portal login, connect where their labels and orders live (Veeqo, Shopify…).',
      'Inventory: import their SKU catalog, collect packaging and SOP docs, choose the packing slip (theirs or ours), schedule the first inbound.',
      'Go-live: test orders end to end, set the date, mark live.',
    ],
  },
  quotes: {
    title: 'Quotes',
    what: 'What a prospect will pay, what it costs us to serve them, and what’s left — then a proposal they can sign.',
    steps: [
      '+ New quote: name the company, pick the model that matches how they sell (DTC, subscription / batch drop, DTC + wholesale, B2B only, FBA prep, launch, storage-only, project) and their volume. The standard rate card prices it at the right tier.',
      'Pricing & profit: left = the prospect (volume, drops, storage, inbound, returns), middle = our price, right = our cost model. The bill shows their month (or project) line by line; Profit at volume shows contribution at three volumes, phase by phase.',
      'Value-added services: tick what they need — kitting, inserts, gift notes, FBA prep, lot tracking, routing-guide compliance, Saturday shifts and more. Set the rate and share; our labor and material cost ride along so the margin stays real. Tick what prints under “What’s included”.',
      'Proposal: write the opening in their words ({company}, {first}, {volume} fill themselves), three points that matter to them, terms and validity. Preview, then Save PDF (print dialog → Save as PDF, margins None). The standard rate card prints the same way as a generic rate card for cold outreach.',
      'Save, mark it Sent. When they sign, “Make it their rate card” turns the quote into their billing rates.',
    ],
  },
  compliance: { title: 'Compliance', what: 'Documents brands have sent that need a yes or a no.', steps: ['Open a document, read it, Approve or Reject with a note.', 'Approving completes the matching onboarding step; rejecting tells the brand what to fix.'] },
  skus: { title: 'SKUs', what: 'Every brand’s catalog: codes, barcodes, weights, packaging.', steps: ['Pick a brand to see its items. Fix a barcode or weight here when a scan or a label rate comes out wrong.', 'New SKUs arrive automatically from orders and the catalog import; remove ones that shouldn’t be picked.'] },
  markets: { title: 'Integrations', what: 'ShipBay-level keys and app credentials that the connections run on.', steps: ['Veeqo and Resend keys live here; brand-specific connections are made under that brand’s Onboarding → Systems.', 'OAuth app keys (Shopify, Amazon, eBay, Etsy, TikTok) are only needed if we move from pasted tokens to one-click connects.'] },
  settings: { title: 'Client settings', what: 'Contact, ship-from address and portal details per brand.', steps: ['Pick the brand, edit, save. The ship-from address is what carriers see on labels for that brand.'] },
  admin: { title: 'Admin settings', what: 'Who can sign in to shipbay.dashboard, and as what.', steps: ['Add user: staff get the warehouse and client screens; client admins/users get their brand’s portal only. A temporary password is shown once and can be emailed.', 'Reset password when someone is locked out. Deactivate instead of deleting — history stays intact and they can be switched back on.', 'Only shipbay admins see this page.'] },
  // client side
  home: { title: 'Overview', what: 'Where your account stands and what we need from you.', steps: ['The four tiles are your onboarding phases; click one to see each step and upload what’s asked.', 'Once you’re live, this page shows today’s orders, units on hand and anything waiting on you.', 'Your team card has who to call. Inbound stock goes to the address shown.'] },
  corders: { title: 'Orders', what: 'Every order we’ve received for you, with status and tracking.', steps: ['New = in our queue. Packed = verified and boxed. Shipped = label bought; click the tracking number to follow it.', 'On hold means something needs your answer — your account manager will have messaged you.'] },
  products: { title: 'Products', what: 'Your catalog as we have it.', steps: ['Check codes, barcodes and weights — these drive picking accuracy and postage. Send corrections to your account manager.'] },
  documents: { title: 'Documents', what: 'Everything you’ve sent us and its review status.', steps: ['Pending = we have it and are reviewing. Approved = done. Rejected = see the note and re-upload from Overview.'] },
  owner: {
    title: 'the Owner area',
    what: 'Your money, your leads and the plays behind them — behind a second passphrase.',
    steps: [
      'Financials: pick a month. Money in, money out, bottom line. The pie shows where it went; the list underneath is every transaction, yours and QuickBooks’. Add an expense or income with the buttons.',
      'Sales → Overview is the command center: the funnel, who’s waiting on you, and how each channel and list is doing. All leads, Email, Calls and Third party are the detail behind it.',
      'Email shows each reply in full — tag it Positive or Negative. Calls is the dialer. Third party is where Fulfill.com and partner leads go.',
      'Strategies: one card per play with its live numbers and a log. Add a note when something changes.',
      'Admin settings → Careers: the roles on shipbay3pl.com/careers. Edit a role’s pay, description or status (only Open roles show on the site), add a new one, and read every application sent from the site.',
    ],
  },
  apptsetting: {
    title: 'Appt. Setting',
    what: 'Dial the queue, book the call on the closer’s calendar while the prospect is still on the line, send your email after.',
    steps: [
      'Calls: the next lead is on the card. Script opens your call script beside it, filled in with their name and company. Edit saves your own version; Derek sets the shared one.',
      'Start call, talk, and press Book a call the moment they say yes. The closer’s Calendly opens with the prospect already filled in: pick the time with them and confirm. Calendly sends the invite and the meeting link, and you are added as a guest, so the call is on your calendar and the closer’s. You are both on it.',
      'End call opens the debrief. Every answer, the lead’s next step and the booking are saved together on the server. If your connection drops, the call waits in this browser and goes up when you are back; it is never logged twice.',
      'Logged the wrong lead? Your last calls → Void. It drops out of every count and the lead gets the try back. Nothing is deleted.',
      'Dashboard: your day. Calls to make, follow-ups due, emails sent, calls booked, and your bonus bar once Derek has set your target. Under it, every follow-up: Email sends the next one, Call dials, Done means you followed up another way, Stop ends follow-ups for that lead.',
      'Follow-ups: every email you send flags the lead. First follow-up 2 business days later, then 4, then 7. A reply, a booked call or a call where you reach a person clears it. The same list is under Conversations → Follow-ups.',
      'Your leads: Derek gives each setter leads in random blocks of 100. They are yours alone, nobody else dials them. When you book the call, the lead moves to your closer and you keep the credit. The card shows Setter → Closer for the lead on screen.',
      'Calendar: every call you booked, and the calls you take. Open one for the join link, Reschedule or Cancel. Book a call (top right) books without dialing, for someone who called back or replied by email; not on your list? Add them as a client right there. The Calendar button on Calls brings you here.',
      'Scoreboard: every setter ranked by calls booked, with dials, reach rate, show rate and leads left to dial. Today, 7 days or 30 days.',
      'Emails: every email carries the Calendly link. If your own template has no {booking} in it, the link is added as the last line.',
      'A setter books for the closer Derek assigned them. Each closer pastes their own Calendly event link under Settings → My Calendly link; until they do, bookings go on the team Calendly and whoever hosts that page takes the call.',
    ],
  },
  salesdesk: {
    title: 'CRM',
    what: 'Your pipeline, the calls on your calendar, and what your setters are doing.',
    steps: ['Calendar: every call on your Calendly (booked by a setter, by you, or by the prospect from a link) and Google Calendar. After a call, open it and pick how it went; that is what the show rate counts.', 'Setters: the chain is lead → setter → closer. Leads shows each setter, the closer they set for, and where their leads are: not dialed yet, being worked, with the closer, won. Derek gives leads out here, at random, 100 at a time, and can take back the ones not dialed yet. Below it: each setter’s dials, calls booked, what is coming up and how many showed; click a name for their next appointments and last calls.', 'Your leads: change the stage, log a call outcome, keep notes and a follow-up date.', 'Settings → My Calendly link: the Calendly event setters book you on. Your hours live in Calendly.'],
  },
};
