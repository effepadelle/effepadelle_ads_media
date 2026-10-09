# Vanzelf posten op Instagram

Dit repo bevat de gerenderde posts en wanneer ze de deur uit moeten. Een taak op
GitHub kijkt elk uur of er iets aan de beurt is en zet het erop. Verder is er
niets: geen code van de planner, geen fotobibliotheek, geen projectstaat.

Zo hangt het aan elkaar:

    planner, Agenda        je zet datums en drukt op Zet klaar
    instagram-ad/gepland   de renders plus plan.json
    Zet agenda online      brengt dat hierheen en duwt het naar GitHub
    dit repo               de taak posten.yml draait elk uur
    gepland/gepost.json    wat eruit is, zodat niets twee keer gaat

## Eenmalig instellen

Dit is het enige handwerk. Daarna kijk je er niet meer naar om.

### 1. Je Instagram moet zakelijk zijn

In de app: Instellingen, Accounttype en tools, Overschakelen naar professioneel
account, en kies Bedrijf. Aan je feed verandert niets. Een privéaccount kan niet
via de API gepost worden, en daar is geen omweg voor.

### 2. Een app bij Meta

Op [developers.facebook.com](https://developers.facebook.com):

1. Rechtsboven **My Apps**, dan **Create App**.
2. Bij de vraag waar de app voor is: **Other**, dan **Business**.
3. Geef hem een naam, bijvoorbeeld EffePadelle Planner. Alleen jij ziet die.
4. In de app, bij **Add products**: kies **Instagram**, en daarbinnen
   **Instagram API setup with Instagram login**.
5. Bij **Generate access tokens**: koppel je Instagram-account en maak een
   sleutel aan. Zet de rechten aan die over publiceren gaan
   (`instagram_business_basic` en `instagram_business_content_publish`).
6. Je krijgt een lange sleutel te zien. Kopieer die. Op dezelfde pagina staat
   het nummer van je account; kopieer dat ook.

Je hoeft de app **niet** in te dienen voor beoordeling. Dat is alleen nodig als
anderen hem gebruiken; jij post op je eigen account.

### 3. De sleutel hierheen

Dit doet de planner voor je. Open in de planner de Agenda van het project, druk
op **Koppel Instagram** (of **Instellen**), en plak de sleutel. Staat `gh` op je
Mac en ben je ingelogd (`brew install gh`, dan `gh auth login`), dan zet de
planner hem met een klik ook hier bij de geheimen neer.

Elk project heeft zijn eigen twee geheimen, met de projectnaam erachter:

- `IG_TOKEN__ROKU_FILMS` — de sleutel van dat account
- `IG_USER__ROKU_FILMS` — het nummer van dat account

De taak kiest per post de sleutel van zijn eigen project, en post een post
nooit met de sleutel van een ander project. Is er voor een project geen
sleutel, dan slaat hij die post over en wordt de taak rood, zodat je er een
mailtje van krijgt.

De oude geheimen `IG_TOKEN` en `IG_USER` mogen blijven staan. Die worden alleen
nog gebruikt voor posts van voor het koppelen per project, of als het account
van die sleutel precies het account is waar de post heen moet.

Secrets zijn versleuteld en staan niet in de bestanden, ook niet in een openbaar
repo.

### 4. Kijken of het klopt

Tabblad **Actions**, links **Posten op Instagram**, dan **Run workflow**, en zet
**Alleen kijken** aan. Hij plaatst dan niets maar zegt wel op welk account hij
binnenkomt en wat er aan de beurt is. Staat daar jouw accountnaam, dan is alles
in orde.

## Waar je op moet letten

**Wat je na het klaarzetten verandert, gaat er vanzelf uit.** Pas je in de
planner een ingeplande post aan (caption, beelden, stories, tijd), of staat hij
niet meer in je raster, dan haalt de planner hem meteen uit het plan, ook hier.
Zo kan er nooit een oude versie online gaan. Druk op Zet klaar om hem opnieuw
in te plannen. Zet klaar zet ook geen posts van andere projecten terug die hier
al weg waren.

**De sleutel verloopt na zestig dagen.** De planner laat in de Agenda zien tot
wanneer hij geldig is, en met **Verleng 60 dagen** in het koppelvenster maak je
een nieuwe. Staat `gh` erop, dan gaat die meteen ook hierheen. Verloopt hij
toch, dan mislukt de taak en krijg je daar een mailtje van.

**Over tijd raken doet hij niet ongemerkt.** Staat er iets meer dan twee dagen
te wachten, dan slaat hij het over in plaats van drie posts achter elkaar de
deur uit te doen. Wil je ze alsnog: **Run workflow** en dan met `--inhalen`,
of gewoon nieuwe datums zetten in de planner.

**Instagram haalt de beelden zelf op** via een openbare link naar dit repo.
Daarom moet dit repo openbaar zijn. Zet je hem op besloten, dan komt er geen
enkele post meer uit en zegt de taak dat het beeld niet verwerkt kon worden.

**Een carrousel mag maximaal tien slides hebben** en alles moet JPEG zijn. De
planner zorgt voor dat laatste.

## Zelf draaien

    IG_TOKEN=... IG_USER=... IG_BASIS=https://raw.githubusercontent.com/effepadelle/effepadelle_ads_media/main/gepland \
      node instagram.mjs --proef

`--proef` kijkt alleen. Zonder die vlag plaatst hij wat aan de beurt is.
