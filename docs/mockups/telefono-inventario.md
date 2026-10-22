# Arianna sul telefono: inventario e piano (D-293)

Studio della chat web `apps/hud` a 390 px di larghezza (iPhone 13-16), aperta via Tailscale (D-292). Mockup: `docs/mockups/telefono.html`.

**Cosa c'è già.** Sotto `md` (768 px) la barra sinistra diventa un cassetto aperto da «☰» (`App.vue`, `SideBar.vue`) e la barra degli agenti è un cassetto da destra fino a `3xl`. Impostazioni passa da indice a sezione sotto `lg`, la Wiki ha l'albero a cassetto (`phoneTree`), il calendario delle routine ha la vista di un giorno (`narrow`), le azioni dei messaggi restano visibili con `hover: none`. È un'app desktop che si stringe, non un'app pensata per il telefono: le parti ci sono, mancano l'ordine, la navigazione e le misure del tocco.

Gravità: **A** rende la pagina inutilizzabile, **M** la rende scomoda, **B** è un ritocco.

## Inventario

| # | Area | Problema sotto 430 px | File | G. |
| --- | --- | --- | --- | --- |
| 1 | Struttura | `html, body, #app { height: 100% }`, niente `viewport-fit=cover` né `env(safe-area-inset-*)` in tutta l'app. Con la tastiera iOS la finestra visibile si accorcia ma la pagina no: il campo di scrittura in fondo alla griglia finisce sotto la tastiera, o la pagina intera scorre e l'intestazione esce dallo schermo | `style.css`, `index.html`, `App.vue` | A |
| 2 | Navigazione | Le 15 aree e le conversazioni stanno solo nel cassetto di «☰»: tornare alla lista, aprire Pensieri o le approvazioni costa sempre due tocchi e un cassetto che copre tutto. Nessuna barra in basso, nessun «indietro» dentro una conversazione | `App.vue`, `SideBar.vue` | A |
| 3 | Intestazione | A 390 px stanno in fila «☰», titolo, etichetta «Interno · può uscire» (circa 150 px), telefono, `InstallationBadge`, tema, barra agenti: del titolo restano pochi caratteri; pulsanti da 32-36 px | `App.vue` | A |
| 4 | Approvazioni | Le decisioni che aspettano l'utente e gli agenti al lavoro stanno nel cassetto destro (`StatusPanel`), dietro un'icona «pannello» con un numerino: è proprio ciò che si fa dal telefono. Face ID compare solo dopo il 403 `verification-required`: il pulsante non dice che lo chiederà | `StatusPanel.vue`, `ApprovalCard.vue`, `PendingDecisions.vue`, `lib/api.ts` | A |
| 5 | Campi | Testo dei campi sotto 16 px: `body` 15 px (il compositore lo eredita), `.field` con `text-[14px]` in Cerca, Impostazioni, filtri. Safari ingrandisce la pagina al tocco del campo e non torna indietro | `style.css`, `ChatView.vue`, `DraftChat.vue`, `SearchDialog.vue`, `SettingsPage.vue` | A |
| 6 | Compositore | «+» da 30 px, invia e ferma da 38 px; sotto, 2-3 righe mono a 12 px («Invio per inviare · Maiusc+Invio a capo · / per i comandi…» e la frase dell'etichetta) che rubano lo spazio sopra la tastiera e parlano di tasti che il telefono non ha; menù «/» con la colonna del comando fissa (`w-36`) | `ChatView.vue`, `DraftChat.vue`, `PlusMenu.vue` | A |
| 7 | Lista conversazioni | Sotto `md` le icone Affianca, Fissa, Archivia, Elimina sono sempre visibili, ognuna di circa 23 px, e tolgono 7-8,5 rem al titolo; nessuna pressione lunga né scorrimento sulla riga. «Affianca» non ha senso a 390 px | `ConversationList.vue` | A |
| 8 | Avvisi in alto | Errore, avviso, chiamata, incognito in scadenza, chiamata rimasta aperta si impilano sotto l'intestazione e spingono giù i messaggi | `App.vue` | M |
| 9 | Dialoghi | Cerca e Nuova conversazione sono finestre centrate (`pt-[12vh]`, `max-h-[76vh]`): con la tastiera il fondo esce dallo schermo. Su telefono servono fogli a schermo intero | `SearchDialog.vue`, `NewConversationDialog.vue`, `ConfirmDialog.vue`, `LabelLegend.vue` | M |
| 10 | Pannelli a tutta altezza | «Chiedi a lato», Computer, chiamata in arrivo e chiamata: `fixed inset-0` o `inset-y-0` senza margini di safe-area; con `viewport-fit=cover` l'intestazione va sotto l'isola dinamica | `SidePanel.vue`, `ComputerPanel.vue`, `IncomingCall.vue`, `CallView.vue` | M |
| 11 | Toast | In basso a destra (`bottom-4`, larghezza 360 px): coprono il compositore e la riga della casa | `NoticeToasts.vue` | M |
| 12 | Misure del tocco | `.btn` circa 37 px d'altezza, `.switch` 34×20, icone con `p-1` (23-28 px), `RowMenu` 28 px, ‹ › del calendario 30 px: quasi tutto sotto i 44 px | `style.css`, `RowMenu.vue`, `RoutineCalendar.vue` | M |
| 13 | Impostazioni | Indice e sezione ci sono, ma «‹ Impostazioni» è un link piccolo in testa al contenuto; la barra di salvataggio è `sticky bottom-4` senza safe-area; campi a larghezza fissa (`w-[190px]`, `min-w-[220px]`) | `SettingsPage.vue`, `SettingsSaveBar.vue` | M |
| 14 | Pagine dense | Progetti (griglie fisse, tabelle, `w-[480px]`), Finanze (tabelle dei movimenti), Confronto modelli, Consumi (`min-w-[640px]`), Cardwall a colonne, Conoscenza (grafo su canvas, 2132 righe senza un punto di rottura) | `ProjectsPage.vue`, `Finance*.vue`, `ModelsCompare.vue`, `UsagePage.vue`, `CardwallPage.vue`, `KnowledgePage.vue` | M |
| 15 | Wiki | L'albero è già a cassetto; restano la barra degli strumenti dell'editor (pulsanti da 2 rem) e le tabelle a layout fisso | `WikiPage.vue`, `WikiEditor.vue`, `style.css` | M |
| 16 | Tema sul telefono | `theme-color` fisso `#0e1b1f` anche col tema chiaro; barra di stato `default` (non usa lo spazio sotto l'isola) | `index.html` | B |
| 17 | Solo Mac | Ufficio, Studio, browser dell'agente e Dispositivi sono pensati per il Mac (canvas, iframe, `localOnly` di D-292): sul telefono vanno detti «solo sul Mac», non mostrati rotti | `OfficePage.vue`, `StudioPage.vue`, `BrowserPage.vue` | B |
| 18 | Schermate di accesso | Già a misura di telefono (`min-h-dvh`, codice a 26 px); mancano safe-area, pulsante a tutta larghezza da 48 px, e il nome del Mac a cui ci si collega | `RemoteAccessPage.vue` | B |

## Scelte del mockup

- **Punto di rottura: sotto `md` (48 rem, 768 px)**, lo stesso che oggi fa diventare cassetto la barra sinistra: un solo confine, nessun terzo stato. Una variante `phone` in `style.css` (`@custom-variant phone (@media (max-width: 47.99rem))`) e, a parte, `@media (pointer: coarse)` per le misure del tocco (44 px) anche sull'iPad.
- **Barra in basso a 5 voci:** *Chat* (lista delle conversazioni, la cosa più usata), *Attende te* (approvazioni con Face ID e agenti al lavoro, col numero: è il motivo principale per aprire Arianna fuori casa), *Pensieri* (catturare un'idea al volo, D-080), *Dashboard* (lo stato in un colpo d'occhio, D-248), *Altro* (tutte le altre aree nei tre gruppi di `nav-groups.ts`, con Impostazioni in fondo). Si nasconde dentro una conversazione e con la tastiera aperta.
- **Dentro una conversazione:** intestazione «‹», titolo su una riga, etichetta come pallino colorato (la parola sotto il titolo), telefono e «⋯» (tema, legenda, archivia, ecc.). Compositore fisso sopra la tastiera con campo a 16 px, «+» e invia da 44 px; la riga d'aiuto diventa una sola riga «Privato · resta sul Mac ⓘ».
- **Decisioni:** il pulsante dice «Approva con Face ID» quando la pagina è sull'origine remota (`onRemoteOrigin`); il resto del meccanismo di D-292 non cambia.
- **Stesso aspetto:** token di colore, font (Figtree, Chakra Petch, JetBrains Mono), carte con gli angoli HUD, personaggi pixel; nessun bordo colorato al focus nei campi, barre di scorrimento globali.

## Piano di costruzione

Ogni tappa è un ramo e una prova sull'iPhone; il desktop non cambia finché non si attraversa il punto di rottura.

| Tappa | Cosa | File principali | Ore |
| --- | --- | --- | --- |
| 1. Fondamenta | `viewport-fit=cover`; variabili `--safe-top/bottom` da `env()`; `100dvh`; altezza della tastiera da `visualViewport` in `--kb` (`lib/viewport.ts`); campi a 16 px sotto `md` e con `pointer: coarse`; `.btn`, `.switch`, icone a 44 px con `pointer: coarse`; `theme-color` dai token; variante `phone` | `index.html`, `style.css`, `main.ts`, `lib/viewport.ts` | 4 |
| 2. Navigazione | `PhoneTabBar.vue` sotto `md` al posto di «☰»; `lib/phone-nav.ts` (pura: quale voce è attiva per ogni pagina, quando la barra si nasconde, cosa sta in «Altro»); `MorePage.vue` con i gruppi di `nav-groups.ts`; intestazione corta | `App.vue`, `SideBar.vue`, nuovi `PhoneTabBar.vue`, `MorePage.vue`, `lib/phone-nav.ts` | 6 |
| 3. Lista e conversazione | Lista a schermo intero con righe da 64 px, azioni con pressione lunga (foglio in basso) e niente «Affianca»; intestazione con «‹»; compositore sopra la tastiera; riga d'aiuto corta; avvisi in alto in una sola fila | `ConversationList.vue`, `ChatView.vue`, `DraftChat.vue`, `PlusMenu.vue`, `App.vue` | 7 |
| 4. Attende te | Pagina con approvazioni, decise altrove e agenti al lavoro (il contenuto di `StatusPanel`), pulsanti a tutta larghezza, «Approva con Face ID» sull'origine remota | nuovo `PendingPage.vue`, `StatusPanel.vue`, `ApprovalCard.vue`, `PendingDecisions.vue` | 5 |
| 5. Fogli e pannelli | Cerca, Nuova conversazione, conferme, legenda come fogli a schermo intero; safe-area per pannelli, chiamate e toast (toast in alto sotto l'isola) | `SearchDialog.vue`, `NewConversationDialog.vue`, `ConfirmDialog.vue`, `LabelLegend.vue`, `SidePanel.vue`, `ComputerPanel.vue`, `CallView.vue`, `IncomingCall.vue`, `NoticeToasts.vue` | 5 |
| 6. Impostazioni | Elenco a righe da 48 px, intestazione con «‹ Impostazioni», barra di salvataggio sopra la safe-area, campi a tutta larghezza | `SettingsPage.vue`, `SettingsSaveBar.vue` | 4 |
| 7. Pagine dense | Routine, Pensieri, Dashboard, Wiki in lettura a una colonna; Progetti, Clienti, Finanze con tabelle che diventano righe; Ufficio, Studio, Conoscenza col cartello «Meglio sul Mac» e un riassunto | pagine relative | 8-12 |
| 8. Accesso | Ritocchi di `RemoteAccessPage.vue` come nel mockup | `RemoteAccessPage.vue` | 1 |

Totale: circa 40-44 ore.

**Come non rompere il desktop.** Ogni regola nuova sta dietro `phone:` (sotto `md`) o `pointer: coarse`; i componenti nuovi (`PhoneTabBar`, `MorePage`, `PendingPage`) esistono solo sotto `md`; le classi di oggi restano com'erano sopra `md`. A ogni tappa un giro a 1512 px e a 2560 px della chat, di Impostazioni e di Progetti prima della prova sul telefono.

**Test.** La logica della navigazione in `lib/phone-nav.ts`, pura, con `apps/hud/test/phone-nav.test.ts` (voce attiva per ogni pagina di `route.ts`, barra nascosta in conversazione e con la tastiera, «Altro» che contiene ogni area di `NAV_GROUPS` una volta sola, nessuna area «solo Mac» come voce della barra). `lib/viewport.ts` con un `visualViewport` finto (altezza della tastiera, rotazione, chiusura). Un test che fallisce se un `input`, `textarea` o `.field` nuovo dichiara un testo sotto i 16 px senza la variante del telefono. Prova a mano sull'iPhone a ogni tappa (Safari e app sulla schermata Home).
