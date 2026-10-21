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
    what: 'What a prospect will pay, what it costs us to serve them, and what’s left — before anything is promised.',
    steps: [
      'Pick a quote or start one. The standard rate card prices it at the right tier for the volume; change any line to make it a custom offer.',
      'Left column = the prospect (orders, units, storage, inbound, returns). Middle = our price. Right = our cost model (minutes per order, labor rate, packaging, space).',
      'The client’s month shows the bill line by line. Profit at volume shows contribution at three volumes, phase by phase (waivers → founding rates → standard).',
      'Save when it’s the offer you want to send; mark it Sent. When they sign, “Make it their rate card” turns the quote into their billing rates.',
    ],
  },
  compliance: { title: 'Compliance', what: 'Documents brands have sent that need a yes or a no.', steps: ['Open a document, read it, Approve or Reject with a note.', 'Approving completes the matching onboarding step; rejecting tells the brand what to fix.'] },
  skus: { title: 'SKUs', what: 'Every brand’s catalog: codes, barcodes, weights, packaging.', steps: ['Pick a brand to see its items. Fix a barcode or weight here when a scan or a label rate comes out wrong.', 'New SKUs arrive automatically from orders and the catalog import; remove ones that shouldn’t be picked.'] },
  markets: { title: 'Integrations', what: 'ShipBay-level keys and app credentials that the connections run on.', steps: ['Veeqo and Resend keys live here; brand-specific connections are made under that brand’s Onboarding → Systems.', 'OAuth app keys (Shopify, Amazon, eBay, Etsy, TikTok) are only needed if we move from pasted tokens to one-click connects.'] },
  settings: { title: 'Client settings', what: 'Contact, ship-from address and portal details per brand.', steps: ['Pick the brand, edit, save. The ship-from address is what carriers see on labels for that brand.'] },
  // client side
  home: { title: 'Overview', what: 'Where your account stands and what we need from you.', steps: ['The four tiles are your onboarding phases; click one to see each step and upload what’s asked.', 'Once you’re live, this page shows today’s orders, units on hand and anything waiting on you.', 'Your team card has who to call. Inbound stock goes to the address shown.'] },
  corders: { title: 'Orders', what: 'Every order we’ve received for you, with status and tracking.', steps: ['New = in our queue. Packed = verified and boxed. Shipped = label bought; click the tracking number to follow it.', 'On hold means something needs your answer — your account manager will have messaged you.'] },
  products: { title: 'Products', what: 'Your catalog as we have it.', steps: ['Check codes, barcodes and weights — these drive picking accuracy and postage. Send corrections to your account manager.'] },
  documents: { title: 'Documents', what: 'Everything you’ve sent us and its review status.', steps: ['Pending = we have it and are reviewing. Approved = done. Rejected = see the note and re-upload from Overview.'] },
};
