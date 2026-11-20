# Lore

The setting. Section 19 of `docs/SPEC.md` is copied below verbatim and is
fixed: do not add factions, institutions, currencies or tonal registers. The
**Extensions** section at the end is where authored detail accumulates, written
in the same voice and following the same naming rules.

Player-facing text uses the in-world vocabulary from the table below. Code, data
keys and docs use the plain terms.

---


This section is fixed. Add detail in the same voice. Don't add factions, institutions, currencies or tonal registers.

**Premise.** Nobody governs settled space. Three chartered companies do, each holding a founding charter that grants it monopolies, courts of its own and the right to arm its ships. Everything else runs on paper: every voyage is financed by shareholders, every loss is somebody's insurance claim, and violence is lawful if the right document says so. The frontier is called the Marque, after the letters that license raiding there.

Players are free captains: independent owners flying under an Open Ticket, the cheapest license there is, tolerated by all three companies because someone has to carry the cargo too marginal for a company hull.

The 1600s are in the institutions, not the props. These are spacecraft crewed by professionals in a hard, industrial future. No sails, parchment, tricorn hats, pirate slang or skull-and-crossbones anywhere.

**Theme.** Paper is power. Ledgers, share certificates, court rulings and letters of marque matter more than guns, and the most dangerous cargo is a document.

**The three chartered companies.**

- Kessler & Daughters, "the House". The oldest charter. Freight, provisioning and finance. Seat at Countinghouse in the Hallam system, Home Roads. Patient and legalistic: it never fires first and always sues. Livery ivory.
- The Thirty. A joint-stock company governed by a board of thirty subscribers whose names aren't all public. Mining, refining and heavy shipbuilding. Seat at Quorum in the Vane system, Concessions. Every decision is a vote weighted by shares, and everything is a number. Livery cobalt.
- The Reprisal Company. Privateers who incorporated. Arms, propellant and salvage. Seat at Barratry in the Landfall system, the Marque. Chartered to "recover losses" from rivals, which in practice means licensed raiding. Swagger, prize money, and a share of every capture for the crew. Livery verdigris.

Everyone else is either a free captain (players and independent NPCs) or one of the Unlettered: raiders with no letter of marque, which is the only thing that makes them pirates. Their haven is Jettison in the Bitter End system.

**Neutral institutions.**

- The Bourse, at Parity in the Home Roads: the stock exchange.
- The Prize Court, at Soundings: rules on captures, posts offenders and collects fines.
- Underwriters' Hall, at Parity: insures every hull and is itself listed.
- The Gazette: the news feed.

**Regions and systems.**

- The Home Roads, secured: Parity, Hallam, Fairlead, Soundings, Mendes, Tolliver.
- The Concessions, contested, where the companies' grants overlap: Vane, Ostrand, Adeyemi, Banerjee, Offing, Lindqvist, Lee Shore, Narrows.
- The Marque, lawless: Landfall, Doldrum, Okonjo, Bitter End, Sato's Error, Last Entry.

**Vocabulary.**

| Plain term (code, data, docs) | What the player reads |
| --- | --- |
| credits | marks |
| stock exchange | the Bourse |
| commodity market | the Staple |
| shipyard, ship editor | the Yard, the Loft |
| blueprint | draught |
| hangar | the Moorings |
| mission, mission board | commission, the Factor |
| news feed | the Gazette |
| leaderboard | the Register |
| wanted | posted |
| fine | composition |
| ship destroyed | written off |
| insurance payout | the claim |
| pirates | the Unlettered |
| fleet | convoy |
| player-to-player trade | an offer, alongside |

**Commodities.**

| Commodity | Tier | Used for |
| --- | --- | --- |
| Ore | raw | refined into Alloy |
| Ice | raw | refined into Propellant; consumed at ports |
| Grain | raw | made into Provisions |
| Alloy | refined | hull, armor and structural modules; made into Machinery |
| Propellant | refined | jump fuel |
| Provisions | consumer | consumed at every port |
| Machinery | manufactured | engines and reactors; consumed at ports |
| Circuitry | manufactured | bridges, turrets, shield generators |
| Ordnance | manufactured | missile ammunition; weapon modules |
| Leaf | luxury | a mild stimulant grown only in the Marque and consumed in the Home Roads; the high-margin long haul |

**Monopolies.** In the Home Roads each company holds a monopoly on one good: Kessler on Leaf, the Thirty on Alloy, Reprisal on Ordnance. Carrying a monopoly good there without good standing with its holder is smuggling. Patrols scan, and being caught means confiscation and a composition. There are no other illegal goods.

**Letters of marque.** A captain in good standing can buy a letter from a company at its seat. While it's held, attacking the other two companies' ships outside the Home Roads doesn't get the captain posted, and prize cargo sells at a premium at the issuer's ports. Only cargo scooped from a destroyed ship counts as prize cargo, and the premium stays below the share of cargo lost when a ship is destroyed, so a capture staged between friends loses money. A player holding a letter counts as that company's ship for this rule. Holding one costs standing with the other two companies, and it lapses if standing with the issuer falls.

**Listed companies.**

| Ticker | Company | Parent | Sector | Earns from |
| --- | --- | --- | --- | --- |
| KSC | Kessler Carriage | Kessler & Daughters | Freight | freight delivered in the Home Roads and Concessions |
| DPR | Daughters' Provision | Kessler & Daughters | Agriculture | Grain, Provisions and Leaf leaving its ports |
| HRC | Home Roads Chandlery | Kessler & Daughters | Ship fittings | its modules (bridges, hull, cargo bays, tanks) and Circuitry leaving its ports |
| TLY | Tally Extraction | The Thirty | Mining | Ore and Ice leaving its ports |
| TFA | Thirtyfold Alloy | The Thirty | Refining | Alloy and Machinery leaving its ports |
| SLP | Slipway Thirty | The Thirty | Heavy yards | its modules (reactors, engines, thrusters, armor) |
| RPO | Reprisal Ordnance | The Reprisal Company | Arms | its modules (weapons, turrets, racks, shield generators) and Ordnance leaving its ports |
| MQP | Marque Propellant | The Reprisal Company | Fuel | Propellant leaving its ports |
| PZS | Prize & Salvage | The Reprisal Company | Frontier freight | freight delivered in the Marque, and salvage |
| UWH | Underwriters' Hall | independent | Insurance | premiums less claims |

**Naming.**

- Systems are surveyors' and investors' surnames or plain words, as listed above.
- Ports are terms from shipping, law and finance. Fixed: Countinghouse, Quorum, Barratry, Jettison, the Bourse, the Prize Court. Assign the rest from this bank: Demurrage, Lading, Tare, Bottomry, Ullage, Tontine, Agio, Specie, Salvage, Cabotage, Lazaret, Careenage, Chandlery, Ropewalk, Supercargo, Drawback, Entrepôt, Flotsam, Average, Manifest, Tret, Dunnage, Ballast, Stowage, Respondentia, Lien, Escrow, Tariff.
- Ships are named with legal, insurance and accounting phrases or plain commercial optimism: Without Prejudice, Force Majeure, Fair Wear and Tear, Errors and Omissions, Net of Fees, Third Dividend, Prudent Return, Act of God, Mrs. Kessler's Patience.
- People have surnames from many trading diasporas, mixed freely with given names: van der Meer, Adeyemi, Leung, Mehta, Carvalho, Bello, Sarkissian, Whitlock. There are no titles of nobility. Titles are offices: Factor, Supercargo, Underwriter, Subscriber, Master, Assessor.
- Modules are named by maker and plain function, like a parts catalog: "Slipway Thirty Mk II Reactor".

**Voice.**

- Dry, exact and institutional. Understatement over drama. The world is not impressed by the player.
- Humor comes from bureaucracy applied to violence and is never signposted. No punchlines, no exclamation marks, no winking at the reader.
- Plain modern English with period institutional nouns. No archaic grammar, no technobabble, no chosen-one framing.
- Port descriptions run two or three sentences with one concrete physical detail and one economic fact.
- Gazette headlines are subject, verb, consequence. Semicolons are welcome.
- System messages carry the voice too.

Samples to match:

- Port: "Demurrage began as a holding orbit for ships waiting on Hallam's inspectors and became a town when the queue never cleared. Everything here is priced by the hour. Kessler Carriage keeps its largest provisioning depot on the ring."
- Headline: "Kessler Carriage cuts dividend after third convoy lost off Vane; Unlettered suspected."
- Headline: "Thirty votes to reopen Ostrand diggings; Tally Extraction up on the count."
- Commission: "The Factor at Lading requires forty units of Machinery at Quorum within two days. Payment on delivery, less the Factor's fee. Late delivery will be noted."
- Rejected purchase: "The Staple declines. You are 1,240 marks short."
- Death: "Written off at Bitter End. Underwriters' Hall has settled your claim for 18,400 marks and wishes you a more careful year."
- Wanted: "The Prize Court has posted you. Composition is set at 6,000 marks, payable at any port that will still have you."

**The three chains.** Each runs five to seven commissions, is playable solo, and teaches one region.

1. Kessler, "The Daughters' Audit". Old Mrs. Kessler has died and her will leaves the House to "my daughters". Seven women have filed claims. The player is hired as a discreet courier, carrying sealed ledgers between Home Roads ports while rival claimants try to intercept them. The ledgers turn out to show that the House has paid its dividend out of new deposits for a decade. Final choice: deliver them to the Prize Court or to the eldest daughter.
2. The Thirty, "Subscriber Thirty-One". A subscriber has died in the Concessions and the bearer certificate for the seat is missing. The player traces it through a wreck, a salvage auction and the haven at Jettison, with Reprisal agents after the same paper. Whoever holds the certificate holds the seat, and the board would rather buy it back than admit that. Final choice: sell it to the Thirty or to the Reprisal Company.
3. Reprisal, "Prize Money". The player flies with a Reprisal captain taking prizes in the Marque. The Prize Court rules one capture unlawful, because the ship belonged to a Kessler subsidiary flying false papers, and freezes the crew's shares. The player runs evidence, breaks a blockade at Landfall and is called as a witness. Final choice: testify truthfully or perjure for the crew.

Endings change standing and rewards and post a Gazette item. Any market effect is small, temporary and capped per completion, and invariant 6 still holds.

---

# Extensions

Authored detail, added as content is written. Everything here follows the rules
above. Each entry names where it is used, so nothing drifts out of sync with the
data.

## Port assignments

The spec fixes six port names and gives a bank to draw the rest from. Ports are
assigned to systems as the galaxy data is authored in M3; this table is the
record, so a name is never used twice.

| Port | System | Region | Owner | Status |
|---|---|---|---|---|
| Countinghouse | Hallam | Home Roads | Kessler & Daughters | Fixed by the spec: the House's seat |
| the Bourse | Parity | Home Roads | neutral | Fixed by the spec: the stock exchange |
| Underwriters' Hall | Parity | Home Roads | neutral | Fixed by the spec: insurance |
| the Prize Court | Soundings | Home Roads | neutral | Fixed by the spec |
| Quorum | Vane | Concessions | The Thirty | Fixed by the spec: the Thirty's seat |
| Barratry | Landfall | the Marque | The Reprisal Company | Fixed by the spec: Reprisal's seat |
| Jettison | Bitter End | the Marque | the Unlettered | Fixed by the spec: their haven |

*(The remaining ports are assigned from the spec's bank when the galaxy data is
authored. Unused names stay in the bank.)*

## Writing checklist

Before any player-facing string ships, it passes these:

- Uses the in-world term, not the plain one: marks, not credits; the Staple, not
  the commodity market; draught, not blueprint.
- No exclamation marks. No second-person flattery. The world is not impressed by
  the player.
- Port descriptions: two or three sentences, one concrete physical detail, one
  economic fact.
- Gazette headlines: subject, verb, consequence. Semicolons are welcome.
- No archaic grammar, no technobabble, no chosen-one framing.
- Nothing nautical or piratical: no sails, parchment, tricorns, pirate slang,
  skulls. The 1600s are in the institutions, not the props.
