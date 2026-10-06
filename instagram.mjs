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
 *     IG_TOKEN__NAAM, IG_USER__NAAM  de sleutel per project, bij naam; de taak
 *                  geeft die van de projecten in het plan mee. (IG_SLEUTELS, alle
 *                  geheimen als JSON, werkt ook nog, maar GitHub houdt een taak
 *                  die dat doet tegen als mogelijk kwaadaardig.)
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
/* En los, zoals de taak ze nu meegeeft: IG_TOKEN__ROKU_FILMS en
   IG_USER__ROKU_FILMS als eigen omgevingsvariabelen. Leeg telt niet. */
for (const [k, v] of Object.entries(process.env)) {
  if (/^IG_(TOKEN|USER)__[A-Z0-9_]+$/.test(k) && v) SLEUTELS[k] = v;
}
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

/* Hoe ver vooruit deze taak kijkt, in minuten. Hij draait elk kwartier; een
   post die binnen dat kwartier aan de beurt is pakt hij nu al op, en dan
   wacht hij tot de minuut zelf. Zo gaat 17:30 om 17:30 en niet pas bij de
   volgende ronde. */
const VOORUIT = Math.max(0, +(process.env.IG_VOORUIT || 16));

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
async function wachtOpDoos(id, token, seconden = 90) {
  const rondes = Math.max(1, Math.ceil(seconden / 3));
  for (let i = 0; i < rondes; i++) {
    const d = await meta(id, { fields: "status_code,status" }, "GET", token);
    if (d.status_code === "FINISHED") return true;
    if (d.status_code === "ERROR" || d.status_code === "EXPIRED") {
      throw new Error("Instagram kreeg het beeld niet verwerkt: "
        + (d.status || d.status_code) + "\n"
        + "  Vaak is dat de link naar het beeld. Staat hij openbaar, en is het "
        + "een JPEG, of een mp4 met H.264 en AAC?");
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

/* Wie je in de caption met @ noemt, krijgt ook een echte tag in de post.
   Dan meldt Instagram "heeft je getagd in een bericht" en staat de post op
   hun tabblad Getagd; een @ in de tekst alleen geeft lang niet altijd een
   melding. Je eigen account niet, elke naam een keer. */
function captionNamen(caption, zelf) {
  const z = String(zelf || "").toLowerCase(), gezien = new Set(), uit = [];
  for (const m of String(caption || "").matchAll(/(^|[^\w.@])@([A-Za-z0-9._]{1,30})/g)) {
    const n = m[2].replace(/\.+$/, ""), k = n.toLowerCase();
    if (!n || k === z || gezien.has(k)) continue;
    gezien.add(k);
    uit.push(n);
  }
  return uit;
}

/* Op een foto moet een tag een plek hebben. Een raster van vijf bij vier,
   want je ziet ze pas als je op de foto tikt. Hoogstens twintig per beeld. */
function fotoTags(namen) {
  return namen.slice(0, 20).map((n, i) => ({ username: n,
    x: Math.round((0.1 + 0.2 * (i % 5)) * 1000) / 1000,
    y: Math.round((0.15 + 0.233 * Math.floor(i / 5)) * 1000) / 1000 }));
}

/* Een doos maken met tags. Weigert Instagram een tag (een privé-account,
   een naam die niet bestaat), dan gaat de post alsnog, zonder tags. */
async function doosMetTags(user, velden, token) {
  try {
    return await meta(user + "/media", velden, "POST", token);
  } catch (err) {
    if (!velden.user_tags) throw err;
    const regels = String(err.message).split("\n").map((r) => r.trim()).filter(Boolean);
    const waarom = regels[1] || regels[0] || "";
    /* Noemt Instagram de naam die niet mag, dan alleen die eruit en de rest
       wel taggen. Anders alle tags eruit: de post gaat altijd door. */
    const alle = JSON.parse(velden.user_tags);
    const rest = alle.filter((t) => !new RegExp("(^|[^\\w.])" + t.username.replace(/[.]/g, "\\.") + "($|[^\\w.])", "i").test(waarom));
    const opnieuw = Object.assign({}, velden);
    if (rest.length && rest.length < alle.length) {
      log("  tag niet gelukt (" + waarom + "); opnieuw zonder @" + alle.filter((t) => !rest.includes(t)).map((t) => t.username).join(", @"));
      opnieuw.user_tags = JSON.stringify(rest);
      try { return await meta(user + "/media", opnieuw, "POST", token); }
      catch (err2) { /* dan zonder tags */ }
    } else {
      log("  tags lukten niet (" + waarom + "); opnieuw zonder tags");
    }
    delete opnieuw.user_tags;
    return await meta(user + "/media", opnieuw, "POST", token);
  }
}

async function plaats(post, cred) {
  const { token, user } = cred;
  // Iedereen uit de caption, plus wie je in de planner zelf tagde.
  const namen = captionNamen(post.caption, cred.wie).concat(
    (Array.isArray(post.tags) ? post.tags : []).map((t) => String(t).replace(/^@/, "").trim()).filter(Boolean))
    .filter((n, i, a) => a.findIndex((x) => x.toLowerCase() === n.toLowerCase()) === i);
  if (namen.length && post.soort !== "story") log("  tags: @" + namen.join(", @"));
  const links = post.beelden.map((b) => BASIS + "/" + b.split("/").map(encodeURIComponent).join("/"));
  log("  beelden:");
  for (const l of links) log("    " + l);

  const link = (b) => BASIS + "/" + String(b).split("/").map(encodeURIComponent).join("/");
  const isFilm = (u) => /\.(mp4|mov|m4v)(\?|$)/i.test(String(u));
  /* Een film verwerken duurt bij Instagram minuten, geen seconden. */
  const FILM = 600;

  /* Een reel: de film en de thumbnail die jij in de planner maakte, als
     cover. share_to_feed, anders staat hij alleen onder Reels en klopt je
     raster niet meer met je profiel. */
  if (post.video) {
    log("  reel: " + link(post.video) + (post.cover ? "\n  cover: " + link(post.cover) : ""));
    const velden = { media_type: "REELS", video_url: link(post.video),
                     caption: post.caption || "", share_to_feed: "true" };
    if (post.cover) velden.cover_url = link(post.cover);
    // Bij een reel alleen de naam: een plek erbij geeft een fout.
    if (namen.length) velden.user_tags = JSON.stringify(namen.slice(0, 20).map((u) => ({ username: u })));
    const doos = await doosMetTags(user, velden, token);
    await wachtOpDoos(doos.id, token, FILM);
    const uit = await meta(user + "/media_publish", { creation_id: doos.id }, "POST", token);
    return uit.id;
  }

  // Een story: een beeld of een film, als story, zonder caption.
  if (post.soort === "story") {
    const film = isFilm(links[0]);
    const velden = film
      ? { media_type: "STORIES", video_url: links[0] }
      : { media_type: "STORIES", image_url: links[0] };
    /* Getagde accounts: die krijgen een vermelding. Kan bij stories sinds
       juli 2025 (user_tags, zonder sticker). Hoogstens twintig. */
    const tags = (Array.isArray(post.tags) ? post.tags : [])
      .map((t) => String(t).replace(/^@/, "").trim()).filter(Boolean).slice(0, 20);
    if (tags.length) velden.user_tags = JSON.stringify(tags.map((u) => ({ username: u })));
    const doos = await doosMetTags(user, velden, token);
    await wachtOpDoos(doos.id, token, film ? FILM : undefined);
    const uit = await meta(user + "/media_publish", { creation_id: doos.id }, "POST", token);
    return uit.id;
  }

  if (!links.length) throw new Error("Deze post heeft geen beelden in het plan.");

  if (links.length === 1 && !isFilm(links[0])) {
    const velden = { image_url: links[0], caption: post.caption || "" };
    if (namen.length) velden.user_tags = JSON.stringify(fotoTags(namen));
    const doos = await doosMetTags(user, velden, token);
    await wachtOpDoos(doos.id, token);
    const uit = await meta(user + "/media_publish", { creation_id: doos.id }, "POST", token);
    return uit.id;
  }

  /* Een carrousel: eerst elk beeld apart, dan de doos eromheen. Een film is
     daarin een kind met media_type VIDEO; aan de extensie te zien, want de
     planner noemt alles in gepland/ naar wat het is. */
  /* Tags kunnen alleen op de foto's, niet op een film. Twintig per foto: bij
     meer namen gaan de volgende op de volgende foto. */
  const kinderen = [];
  let nogTaggen = namen.slice();
  for (const l of links) {
    const film = isFilm(l);
    const velden = film
      ? { media_type: "VIDEO", video_url: l, is_carousel_item: "true" }
      : { image_url: l, is_carousel_item: "true" };
    if (!film && nogTaggen.length) {
      velden.user_tags = JSON.stringify(fotoTags(nogTaggen));
      nogTaggen = nogTaggen.slice(20);
    }
    const kind = await doosMetTags(user, velden, token);
    await wachtOpDoos(kind.id, token, film ? FILM : undefined);
    kinderen.push(kind.id);
  }
  if (nogTaggen.length) log("  niet getagd, geen foto meer over: @" + nogTaggen.join(", @"));
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
  const straks = new Date(nu.getTime() + VOORUIT * 60000);
  const aanDeBeurt = plan.posts.filter((p) => {
    if (alGepost(p)) return false;
    // Wat je zelf vanuit de app plaatst, met muziek, laten we liggen.
    if (p.zelf) return false;
    if (ALLEEN) return p.id === ALLEEN;
    const wanneer = new Date(p.wanneer);
    if (isNaN(wanneer)) return false;
    if (wanneer > straks) return false;
    const dagen = (nu - wanneer) / 86400000;
    return INHALEN || dagen <= RUIMTE;
  }).sort((a, b) => new Date(a.wanneer) - new Date(b.wanneer));

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
    const n = (post.beelden || []).length;
    log("\n" + post.wanneer + "  " + (post.project ? post.project + ": " : "") + post.naam
      + " (" + (post.video ? "reel" : n + (n === 1 ? " beeld" : " beelden")) + ")");
    /* Nog niet zover? Dan wachten tot de minuut. */
    const wacht = new Date(post.wanneer) - new Date();
    if (wacht > 0 && !PROEF && !ALLEEN) {
      log("  wacht " + Math.round(wacht / 1000) + " seconden tot " + post.wanneer);
      await new Promise((r) => setTimeout(r, wacht));
    }
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
                          beelden: post.beelden, video: post.video || undefined,
                          project: post.project || undefined,
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
