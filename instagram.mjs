#!/usr/bin/env node
/* Wat vandaag aan de beurt is op Instagram zetten.
 *
 * Dit script leest gepland/plan.json, kijkt wat er aan de beurt is, en plaatst
 * het. Wat eruit is gegaan komt in gepland/gepost.json, en daar kijkt hij de
 * volgende keer eerst naar. Zo kan hetzelfde nooit twee keer.
 *
 *     node instagram.mjs            plaats wat aan de beurt is
 *     node instagram.mjs --proef    kijk alleen of alles klopt, plaats niets
 *     node instagram.mjs --inhalen  ook posten die al langer over tijd zijn
 *     node instagram.mjs --nu <id>  die ene post, ongeacht de datum
 *
 * Wat er in de omgeving moet staan:
 *     IG_SLEUTELS  alle geheimen van dit repo als JSON (de taak geeft ze mee).
 *                  Per project IG_TOKEN__NAAM en IG_USER__NAAM, bijvoorbeeld
 *                  IG_TOKEN__ROKU_FILMS. De planner zet ze er zelf neer.
 *     IG_TOKEN   de oude, ene sleutel; alleen voor posts van voor het
 *     IG_USER    koppelen per project, of voor een account dat klopt
 *     IG_BASIS   waar de beelden openbaar staan, zonder schuine streep aan het
 *                eind. Instagram haalt ze daar zelf op; hij accepteert geen
 *                bestand dat je meestuurt.
 *
 * En optioneel, mocht Meta iets veranderen:
 *     IG_HOST    standaard graph.instagram.com
 *     IG_VERSIE  standaard v23.0
 */
import fs from "node:fs";
import path from "node:path";

const HIER = path.dirname(new URL(import.meta.url).pathname);
const GEPLAND = path.join(HIER, "gepland");
const PLAN = path.join(GEPLAND, "plan.json");
const GEPOST = path.join(GEPLAND, "gepost.json");

const TOKEN = process.env.IG_TOKEN || "";
const USER = process.env.IG_USER || "";
/* Alle geheimen van het repo. Per project een eigen sleutel, zodat een post
   van ROKU Films nooit met de sleutel van EffePadelle de deur uit gaat. */
let SLEUTELS = {};
try { SLEUTELS = JSON.parse(process.env.IG_SLEUTELS || "{}") || {}; } catch (err) { SLEUTELS = {}; }
const BASIS = (process.env.IG_BASIS || "").replace(/\/+$/, "");
const HOST = process.env.IG_HOST || "graph.instagram.com";
const VERSIE = process.env.IG_VERSIE || "v23.0";

const args = process.argv.slice(2);
const PROEF = args.includes("--proef");
const INHALEN = args.includes("--inhalen");
const ALLEEN = args.includes("--nu") ? args[args.indexOf("--nu") + 1] : null;

/* Hoeveel dagen over tijd we nog plaatsen. Zonder deze grens zou een week
   stilstand betekenen dat er zeven posts achter elkaar de deur uit vliegen,
   en dat is precies hoe een account eruitziet als er iets kapot is. */
const RUIMTE = 2;

function log(...a) { console.log(...a); }
function stop(reden) { console.error("\n" + reden); process.exit(1); }

function lees(pad, terug) {
  try { return JSON.parse(fs.readFileSync(pad, "utf8")); } catch (err) { return terug; }
}

async function meta(pad, velden, methode = "POST", token = TOKEN) {
  // Met http:// of https:// ervoor is het een proef met een nep-Meta.
  const voor = /^https?:\/\//.test(HOST) ? "" : "https://";
  const url = new URL(voor + HOST + "/" + VERSIE + "/" + pad);
  const body = new URLSearchParams(velden);
  body.set("access_token", token);
  let res, tekst;
  if (methode === "GET") {
    for (const [k, v] of body) url.searchParams.set(k, v);
    res = await fetch(url);
  } else {
    res = await fetch(url, { method: "POST", body });
  }
  tekst = await res.text();
  let d = null;
  try { d = JSON.parse(tekst); } catch (err) { /* dan de kale tekst */ }
  if (!res.ok || (d && d.error)) {
    const f = d && d.error ? d.error : {};
    throw new Error("Meta zegt nee op " + pad + "\n"
      + "  " + (f.message || tekst.slice(0, 300)) + "\n"
      + (f.error_user_msg ? "  " + f.error_user_msg + "\n" : "")
      + "  (code " + (f.code || res.status) + (f.error_subcode ? "/" + f.error_subcode : "") + ")");
  }
  return d;
}

/* Een doos klaarzetten duurt bij Instagram even, ook voor een foto. Pas als hij
   FINISHED zegt mag je hem plaatsen; doe je het eerder, dan krijg je een fout
   die nergens op slaat. */
async function wachtOpDoos(id, token) {
  for (let i = 0; i < 30; i++) {
    const d = await meta(id, { fields: "status_code,status" }, "GET", token);
    if (d.status_code === "FINISHED") return true;
    if (d.status_code === "ERROR" || d.status_code === "EXPIRED") {
      throw new Error("Instagram kreeg het beeld niet verwerkt: "
        + (d.status || d.status_code) + "\n"
        + "  Vaak is dat de link naar het beeld. Staat hij openbaar en is het "
        + "echt een JPEG?");
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("Instagram bleef bezig met het beeld. Later opnieuw proberen.");
}

/* Met welke sleutel gaat deze post? Die van zijn eigen project, en anders
   niet. De oude, ene sleutel mag alleen voor een post van voor het koppelen
   per project, of als het account van die sleutel precies het account is
   waar deze post heen moet. Nooit gokken: een post op het verkeerde account
   is het enige wat je niet terug kunt draaien. */
const wieCache = new Map();
async function wieIs(token, user) {
  const k = String(token).slice(-8) + "|" + user;
  if (!wieCache.has(k)) {
    try { wieCache.set(k, (await meta(user, { fields: "id,username" }, "GET", token)).username || null); }
    catch (err) { wieCache.set(k, null); }
  }
  return wieCache.get(k);
}

async function sleutelVoor(post) {
  if (post.account) {
    const token = SLEUTELS["IG_TOKEN__" + post.account];
    const user = SLEUTELS["IG_USER__" + post.account];
    if (token && user) {
      const wie = await wieIs(token, user);
      if (post.username && wie && wie !== post.username) {
        return { reden: "de sleutel IG_TOKEN__" + post.account + " hoort bij @" + wie
          + ", en deze post moet naar @" + post.username };
      }
      return { token, user, wie };
    }
    if (TOKEN && USER && post.username) {
      const wie = await wieIs(TOKEN, USER);
      if (wie === post.username) return { token: TOKEN, user: USER, wie };
    }
    return { reden: "geen sleutel voor " + (post.project || post.account)
      + ". Zet IG_TOKEN__" + post.account + " en IG_USER__" + post.account
      + " bij de geheimen van dit repo, of koppel het project in de planner." };
  }
  if (TOKEN && USER) return { token: TOKEN, user: USER, wie: await wieIs(TOKEN, USER) };
  return { reden: "geen IG_TOKEN en IG_USER voor deze oudere post" };
}

async function plaats(post, cred) {
  const { token, user } = cred;
  const links = post.beelden.map((b) => BASIS + "/" + b.split("/").map(encodeURIComponent).join("/"));
  log("  beelden:");
  for (const l of links) log("    " + l);

  if (links.length === 1) {
    const doos = await meta(user + "/media", {
      image_url: links[0],
      caption: post.caption || "",
    }, "POST", token);
    await wachtOpDoos(doos.id, token);
    const uit = await meta(user + "/media_publish", { creation_id: doos.id }, "POST", token);
    return uit.id;
  }

  // Een carrousel: eerst elk beeld apart, dan de doos eromheen.
  const kinderen = [];
  for (const link of links) {
    const kind = await meta(user + "/media", {
      image_url: link,
      is_carousel_item: "true",
    }, "POST", token);
    await wachtOpDoos(kind.id, token);
    kinderen.push(kind.id);
  }
  const doos = await meta(user + "/media", {
    media_type: "CAROUSEL",
    children: kinderen.join(","),
    caption: post.caption || "",
  }, "POST", token);
  await wachtOpDoos(doos.id, token);
  const uit = await meta(user + "/media_publish", { creation_id: doos.id }, "POST", token);
  return uit.id;
}

async function main() {
  const perProject = Object.keys(SLEUTELS).filter((k) => k.startsWith("IG_TOKEN__"));
  if (!TOKEN && !perProject.length) {
    stop("Er staat geen enkele sleutel bij de geheimen van dit repo. Koppel een "
      + "project in de planner, of zie LEESMIJ.md.");
  }
  if (!BASIS) stop("IG_BASIS ontbreekt: ik weet niet waar de beelden openbaar staan.");

  const plan = lees(PLAN, null);
  if (!plan || !Array.isArray(plan.posts)) {
    stop("Geen gepland/plan.json gevonden. Draai eerst Zet klaar in de planner.");
  }
  const gepost = lees(GEPOST, {});

  // Welke accounts kan ik bedienen? Meteen de beste controle op de sleutels.
  log("Sleutels per project: " + (perProject.map((k) => k.slice(10)).join(", ") || "geen")
      + (TOKEN ? "; en de oude algemene" : ""));

  /* Geplaatst is geplaatst, ook onder de oude naam van voor het koppelen per
     project. Zonder dat zou een post die al online staat opnieuw gaan. */
  const alGepost = (p) => !!(gepost[p.id] || (p.oudId && gepost[p.oudId]));

  const nu = new Date();
  const aanDeBeurt = plan.posts.filter((p) => {
    if (alGepost(p)) return false;
    // Wat je zelf vanuit de app plaatst, met muziek, laten we liggen.
    if (p.zelf) return false;
    if (ALLEEN) return p.id === ALLEEN;
    const wanneer = new Date(p.wanneer);
    if (isNaN(wanneer)) return false;
    if (wanneer > nu) return false;
    const dagen = (nu - wanneer) / 86400000;
    return INHALEN || dagen <= RUIMTE;
  });

  const overtijd = plan.posts.filter((p) => !alGepost(p) && !p.zelf && !ALLEEN
    && new Date(p.wanneer) <= nu
    && (nu - new Date(p.wanneer)) / 86400000 > RUIMTE);
  if (overtijd.length && !INHALEN) {
    log(overtijd.length + " post(s) staan meer dan " + RUIMTE + " dagen over tijd "
      + "en blijven staan. Wil je ze alsnog: node instagram.mjs --inhalen");
  }

  if (!aanDeBeurt.length) {
    const volgende = plan.posts.filter((p) => !alGepost(p) && !p.zelf && new Date(p.wanneer) > nu)
      .sort((a, b) => new Date(a.wanneer) - new Date(b.wanneer))[0];
    log("Niets aan de beurt." + (volgende
      ? " De volgende is " + volgende.naam + " op " + volgende.wanneer + "."
      : " Er staat niets meer in het plan."));
    return;
  }

  let mislukt = 0;
  for (const post of aanDeBeurt) {
    log("\n" + post.wanneer + "  " + (post.project ? post.project + ": " : "") + post.naam
      + " (" + post.beelden.length + (post.beelden.length === 1 ? " beeld)" : " beelden)"));
    const cred = await sleutelVoor(post);
    if (!cred.token) {
      // Deze overslaan en zeggen waarom; de posts van andere projecten gaan door.
      log("  overgeslagen: " + cred.reden);
      mislukt++;
      continue;
    }
    log("  naar @" + (cred.wie || "?"));
    if (PROEF) {
      log("  proef: niet geplaatst");
      continue;
    }
    try {
      const id = await plaats(post, cred);
      gepost[post.id] = { wanneer: new Date().toISOString(), media: id,
                          beelden: post.beelden, project: post.project || undefined,
                          account: cred.wie || undefined };
      fs.writeFileSync(GEPOST, JSON.stringify(gepost, null, 2));
      log("  geplaatst, media " + id);
    } catch (err) {
      log("  mislukt: " + err.message);
      mislukt++;
    }
  }
  // Rood in Actions als er iets bleef liggen, zodat je er een mailtje van krijgt.
  if (mislukt) stop(mislukt + " post(s) niet geplaatst, zie hierboven.");
}

main().catch((err) => stop(err.message));
