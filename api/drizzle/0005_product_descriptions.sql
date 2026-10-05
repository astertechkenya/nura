-- Product descriptions for the 21 original products (Phase 8).
-- Generated from src/db/seed-descriptions.json. Fills ONLY products that have no description
-- yet, so it never overwrites one written in the admin, and running it again changes nothing.
-- Each text is dollar-quoted ($d$...$d$): no escaping needed for apostrophes in the text.
UPDATE "products" SET "description" = $d$A fine gold-tone paperclip chain with a row of lustrous pearls across the front, finished with a neat clasp. Delicate enough for every day, polished enough for an evening out.

Wear it alone with a crisp white shirt, or stack it with a slim watch and the Gold Chain Earrings.$d$, "updated_at" = now() WHERE "sku" = 'nura-001' AND "description" IS NULL;--> statement-breakpoint
UPDATE "products" SET "description" = $d$An off-white blazer with a relaxed, oversized cut, notch lapels and a single-button front. Linen keeps it light and breathable through a warm Nairobi afternoon.

Throw it over a bralette or a fitted tee with dark trousers, or sleeves pushed up over a slip dress for evenings.$d$, "updated_at" = now() WHERE "sku" = 'nura-002' AND "description" IS NULL;--> statement-breakpoint
UPDATE "products" SET "description" = $d$A wrap dress in a dark ground scattered with a bold rust and cream leaf print. Flutter sleeves, a tie waist that adjusts to you, and a high-low hem that moves as you walk.

Pair it with nude heels for a wedding or a garden lunch, or flat sandals for the weekend.$d$, "updated_at" = now() WHERE "sku" = 'nura-003' AND "description" IS NULL;--> statement-breakpoint
UPDATE "products" SET "description" = $d$A wide-brimmed bucket hat in a natural woven straw look, trimmed with an oversized flower at the side. Plenty of shade for market days, the coast and long afternoons outdoors.

It suits anything summery: linen, a slip skirt or a simple tee and shorts.$d$, "updated_at" = now() WHERE "sku" = 'nura-004' AND "description" IS NULL;--> statement-breakpoint
UPDATE "products" SET "description" = $d$Louis Vuitton's roomy Neverfull tote in brown monogram canvas, this one with a playful multicoloured logo motif. Tan handles, and side laces that cinch the shape in or let it open wide.

Big enough for a laptop, a scarf and the day's errands, and smart enough for the office.$d$, "updated_at" = now() WHERE "sku" = 'nura-005' AND "description" IS NULL;--> statement-breakpoint
UPDATE "products" SET "description" = $d$Gold-tone drop earrings: a fine chain falls from a small stud to an interlocking CC pendant with a textured finish. They catch the light with every turn of the head.

Wear them with hair up and an open neckline, or add the Pearl Chain Bracelet for a full set.$d$, "updated_at" = now() WHERE "sku" = 'nura-006' AND "description" IS NULL;--> statement-breakpoint
UPDATE "products" SET "description" = $d$A black strapless maxi dress with a fold-over neckline and a close, column-straight fit from bust to ankle. Clean and simple, so the shape does the talking.

Add a gold cuff and strappy sandals for dinner, or a cropped jacket for the evening chill.$d$, "updated_at" = now() WHERE "sku" = 'nura-007' AND "description" IS NULL;--> statement-breakpoint
UPDATE "products" SET "description" = $d$Olive cargo trousers with a wide, straight leg, patch pockets at the thigh and knee, and a mid-rise waist. Relaxed and practical, and easy to wear from morning to night.

Balance the volume with a cropped top or a fitted tank, and finish with slides or chunky trainers.$d$, "updated_at" = now() WHERE "sku" = 'nura-008' AND "description" IS NULL;--> statement-breakpoint
UPDATE "products" SET "description" = $d$A lilac floor-length gown with an off-the-shoulder neckline and a ruched, draped body that sculpts the waist, finished with a lace panel and a soft fishtail train.

Made for weddings, galas and every occasion that deserves a photograph. Keep accessories minimal: drop earrings and a small clutch.$d$, "updated_at" = now() WHERE "sku" = 'nura-009' AND "description" IS NULL;--> statement-breakpoint
UPDATE "products" SET "description" = $d$A stone-coloured wrap skirt in cotton, falling just below the knee, with an asymmetric overlapping front and a defined waistband. Crisp, easy and cool in the heat.

Wear it with a fitted vest and flat sandals by day, or a tucked-in shirt for the office.$d$, "updated_at" = now() WHERE "sku" = 'nura-010' AND "description" IS NULL;--> statement-breakpoint
UPDATE "products" SET "description" = $d$A rust-brown blazer and matching trousers, cut long and clean with notch lapels and flap pockets. Polished as a set, and just as useful worn as separates.

Wear the set over a black bodysuit for meetings; the blazer alone smartens up jeans.$d$, "updated_at" = now() WHERE "sku" = 'nura-011' AND "description" IS NULL;--> statement-breakpoint
UPDATE "products" SET "description" = $d$A navy popover shirt with a half-button placket, a soft collar and long sleeves. Linen gives it an easy drape and keeps you cool when the day warms up.

Tuck it into off-white chinos, or wear it loose over shorts and roll the sleeves.$d$, "updated_at" = now() WHERE "sku" = 'nura-012' AND "description" IS NULL;--> statement-breakpoint
UPDATE "products" SET "description" = $d$Black trousers with a slim, tapered leg that narrows neatly to the ankle, a flat front and a clean waistband. The foundation of a sharp work wardrobe.

Pair with a white shirt and polished Derby shoes, or a fine knit for dinner.$d$, "updated_at" = now() WHERE "sku" = 'nura-013' AND "description" IS NULL;--> statement-breakpoint
UPDATE "products" SET "description" = $d$A black full-zip hooded jacket from Nike, with zip pockets and a streamlined fit that stays close to the body without restricting movement.

Layer it over a tee for early runs and cool evenings, or wear it with matching joggers for an all-black tracksuit.$d$, "updated_at" = now() WHERE "sku" = 'nura-014' AND "description" IS NULL;--> statement-breakpoint
UPDATE "products" SET "description" = $d$A single-breasted camel blazer in a softly textured weave, with notch lapels and patch pockets: tailoring with an easy, after-dark ease.

Wear it over a rollneck with dark trousers for dinner, or a white shirt and open collar for drinks.$d$, "updated_at" = now() WHERE "sku" = 'nura-015' AND "description" IS NULL;--> statement-breakpoint
UPDATE "products" SET "description" = $d$Black cargo shorts in a longer, below-the-knee length, with deep side cargo pockets and a relaxed fit through the leg.

Wear them with white trainers and a plain tee for the weekend, errands or a day out.$d$, "updated_at" = now() WHERE "sku" = 'nura-016' AND "description" IS NULL;--> statement-breakpoint
UPDATE "products" SET "description" = $d$A light-grey double-breasted suit with peak lapels and a six-button front, matched with straight-leg trousers. Classic tailoring with real presence.

Wear it with a white shirt and a dark striped tie for weddings and big meetings, or an open collar for an evening event.$d$, "updated_at" = now() WHERE "sku" = 'nura-017' AND "description" IS NULL;--> statement-breakpoint
UPDATE "products" SET "description" = $d$Nike's Air Max 270 in a soft blush knit upper with a deep plum heel. The tall Air unit at the heel gives a bouncy, cushioned step and the shoe's unmistakable profile.

Wear them with joggers, cargo trousers or a slip skirt for an easy contrast.$d$, "updated_at" = now() WHERE "sku" = 'nura-018' AND "description" IS NULL;--> statement-breakpoint
UPDATE "products" SET "description" = $d$Black Nike training shorts with an elastic drawcord waist, an above-the-knee length and a white Swoosh. Dri-FIT is Nike's sweat-wicking fabric, made to keep you dry when the session gets hard.

Made for the gym, runs and five-a-side, and comfortable enough for rest days.$d$, "updated_at" = now() WHERE "sku" = 'nura-019' AND "description" IS NULL;--> statement-breakpoint
UPDATE "products" SET "description" = $d$An ice-blue satin midi skirt with an elastic waist and a soft, fluid fall to the mid-calf. It catches the light and moves beautifully.

Pair it with a white tank and trainers by day, or a fitted knit and heels for the evening.$d$, "updated_at" = now() WHERE "sku" = 'nura-020' AND "description" IS NULL;--> statement-breakpoint
UPDATE "products" SET "description" = $d$A braided belt in rich cognac leather with a polished brass-tone buckle. The woven strap gives it texture and lets you fasten it exactly where you want.

It finishes chinos and jeans as easily as tailored trousers. It suits every wardrobe, his or hers.$d$, "updated_at" = now() WHERE "sku" = 'nura-021' AND "description" IS NULL;
