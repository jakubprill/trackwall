---
title: Trackwall w dziesięć minut
description: Krótka prezentacja Trackwall w slajdach, z tym, co powiedzieć i co pokazać na każdym z nich.
pageClass: talk
sidebar: false
aside: false
outline: false
search: false
editLink: false
lastUpdated: false
prev: false
next: false
head:
  - - meta
    - name: robots
      content: noindex
---

# Trackwall w dziesięć minut

Krótka prezentacja Trackwall w slajdach, z tym, co powiedzieć i co pokazać na każdym z nich.

[In English](/talk) · Strzałki, spacja albo J i K przesuwają o jeden slajd. Razem dziesięć minut, dziewięć bez dwóch slajdów opcjonalnych. Demo to wymyślony sklep z dwudziestu repo, ten sam co na zrzutach tej strony.

<section class="slide">

<p class="slide-meta">01 · Otwarcie · 0:30</p>

## Czym jest Trackwall

Aplikacja na pulpit do pracy na **wielu repozytoriach** i z **wieloma agentami** naraz.

- Wskazujesz folder z projektami, a Trackwall trzyma w widoku każde repo: z czego jest zbudowane, kto kogo woła i co czeka na ciebie.
- Obok uruchamia sesje Copilot CLI i mówi, który agent na ciebie czeka.
- Ten sam obraz repo dostają agenci, przez serwer MCP.
- Działa dalej po zamknięciu okna; tray daje znać, gdy agent czegoś potrzebuje.

![Home: repo sklepu demo wokół sesji, które w nich pracują](/screenshots/home.png)

</section>

<section class="slide">

<p class="slide-meta">02 · Problem · 1:00</p>

## Wiele repo, jedna głowa

System z wielu repo trudno trzymać w głowie. Agent szybciej zmienia jedno repo, ale widzi tylko swój folder, a kontekst między nimi przenosisz ty.

- „Które repo implementuje tę integrację i kto z niej korzysta?” Szukasz ręcznie po dziesięciu repo.
- „Czy moja zmiana nie psuje konsumenta w innym repo?”
- „Agent miesza swoje zmiany z moją gałęzią.”
- „Postawienie serwisu z zależnościami zajmuje pół dnia.”
- „Rano nie wiem, co się zmieniło w dwudziestu repo.”
- „Mam kilku agentów naraz i przegapiam tego, który na mnie czeka.”

::: tip Pomysł
Wiedzę o systemie budujemy raz, z kodu, i dajemy ten sam obraz tobie i każdemu agentowi.
:::

</section>

<section class="slide">

<p class="slide-meta">03 · Zasady · 0:40</p>

## Na czym to stoi

- **Fakty z kodu, nie z modelu.** Karta repo i graf są czytane z plików buildu, konfiguracji i kodu, z plikiem i linią jako dowodem. Agent może o nich rozumować, ale ich nie wymyśla.
- **Na tyle lekkie, że można zostawić włączone.** Czyta commity prosto z gita, bez budowania i indeksowania, bez serwera i bazy danych.
- **Jeden obraz dla ciebie i agentów.** Widoki i narzędzia MCP pytają ten sam proces w tle, daemona.
- **Decydujesz ty.** Agent może zaproponować zadanie, ale nic nie rusza bez twojej zgody, a push robisz ty.
- **Na twoim komputerze, twoimi narzędziami:** Copilot CLI, git, mise, Maven i Gradle tak, jak są zainstalowane.

</section>

<section class="slide">

<p class="slide-meta">04 · Graf połączeń · 1:00</p>

## Kto kogo woła, z dowodem

- Trackwall czyta pliki buildu i kod każdego repo i rysuje połączenia: pakiety, klienty HTTP, endpointy.
- Każde połączenie ma plik i linię, które go dowodzą, oraz pewność od „certain” do „possible”.
- Karta repo: stack, aplikacje i porty, endpointy, wymagane narzędzia i taski mise, bez budowania czegokolwiek.

::: info Na ekranie
„Overview”, graf, kto woła `POST /api/payments`, potem klik w połączenie: jego plik i linia.
:::

![Graf połączeń sklepu demo](/screenshots/overview.png)

</section>

<section class="slide">

<p class="slide-meta">05 · Agent widzi inne repo · 1:00</p>

## Agent sam sprawdza konsumentów

- Agent pracuje w jednym repo, ale przez MCP pyta Trackwall o resztę systemu.
- `find_endpoint`: gdzie jest endpoint. `who_calls`: kto go woła. `search_code`: kod we wszystkich repo naraz.
- Zanim zmieni kontrakt, wie, które repo by się zepsuły i dlaczego.

::: info Na ekranie
Sesja w `payments` i pytanie: „Kto korzysta z POST /api/payments i co się stanie, gdy zmienię pole?” Na żywo, z prawdziwym Copilot CLI.
:::

</section>

<section class="slide">

<p class="slide-meta">06 · Zadania agenta · 1:00</p>

## Agent na swojej gałęzi, review robisz ty

- Zadanie agenta dostaje własną kopię repo (worktree) i własną gałąź. Twoja gałąź zostaje nietknięta.
- „Changes”: diff i komentarze na liniach, które wracają do agenta jako review.
- „Verify” uruchamia testy zadania; czerwony wynik wraca do agenta.
- <Badge type="tip" text="nowe" /> **Automatyczne review:** `/review` Copilot CLI na zmianach zadania, a jedno kliknięcie robi z uwagi komentarz na jej linii.
- Gałąź trafia na serwer, a merge request powstaje dopiero, gdy naciśniesz „Push”.

::: info Na ekranie
Zadanie „Retry the payment call”, jego „Changes”, czerwone „Verify”, potem „Review”.
:::

![Zmiany zadania z komentarzami review](/screenshots/task-review.png)

</section>

<section class="slide">

<p class="slide-meta">07 · Zmiana w kilku repo · 0:50</p>

## Jedna zmiana, cztery repo

- Nadzorca (supervisor) dzieli pracę na zadanie dla każdego repo, czeka na twoją zgodę, pilnuje zadań i nimi kieruje.
- Przykład z demo: `payments`, `notifications`, `admin-web` i `billing`.
- <Badge type="tip" text="nowe" /> Proponowana zmiana przychodzi jako jedna karta z repo w kolejności merge; możesz poprawić prompt i odznaczyć repo.
- <Badge type="tip" text="nowe" /> Sekcja „Change” pokazuje każdy merge request z jego stanem i kolejność merge („orders-api woła payments, więc payments zwykle idzie pierwsze”) i pushuje wszystkie części naraz.

</section>

<section class="slide">

<p class="slide-meta">08 · Serwisy · 0:45</p>

## Serwis z zależnościami jednym kliknięciem

- Startuje serwis razem z serwisami, które woła, po kolei, i czeka, aż każdy odpowie.
- Wersja serwisu z zadania może przejąć jego port na test przez cały system.
- Wywołanie endpointu zwraca odpowiedź razem z błędami, które w tym czasie zalogowały wszystkie serwisy.

::: info Na ekranie
„Services”, start serwisu z zależnościami i kolejne serwisy przechodzące w gotowość.
:::

</section>

<section class="slide">

<p class="slide-meta">09 · Wielu agentów naraz · 0:45</p>

## Nie przegapisz agenta, który czeka

- Stan każdej sesji na jednej liście, licznik, powiadomienia i zgody, na które odpowiadasz z traya.
- <Badge type="tip" text="nowe" /> **Widok rozmowy** (preview) zamiast terminala: pliki, na których pracuje agent, kolorowy diff, zmiana pliku widoczna przed zgodą, tryby Agent i Plan, zużycie kontekstu modelu, wklejane zrzuty i logi.

::: info Na ekranie
Siatka sesji, jedna sesja czekająca na zgodę i zgoda udzielona z traya.
:::

![Siatka sesji](/screenshots/sessions-grid.png)

</section>

<section class="slide">

<p class="slide-meta">10 · Poranek · 0:30 · opcjonalnie</p>

## Start my day

- Jeden przycisk bezpiecznie synchronizuje wszystkie repo i uruchamia briefing: co się zmieniło i co czeka na ciebie.
- Plan trzyma większy obraz między zadaniami.

</section>

<section class="slide">

<p class="slide-meta">11 · Bezpieczeństwo · 0:50</p>

## Bezpiecznie i uczciwie o granicach

- Daemon słucha tylko na `127.0.0.1`, a każde żądanie wymaga jego tokenu.
- Żadne narzędzie MCP nie zmienia ustawień Trackwall ani nie odpowiada na zgody; robisz to tylko ty, w aplikacji.
- <Badge type="tip" text="nowe" /> Zadanie z „No approvals” działa w **sandboksie** Copilot CLI: pisze tylko w swoim worktree i nie czyta twoich innych repo ani `~/.ssh`.
- Sekrety pochodzą z mise i są maskowane w logach. Każde wywołanie narzędzia przez agenta jest w „MCP calls”.
- Granica: agent działa jako ty. Trzymanie sekretów z dala od niego chroni przed wypadkiem, nie przed zdeterminowanym agentem.

</section>

<section class="slide">

<p class="slide-meta">12 · Dev container · 0:30 · opcjonalnie</p>

## <Badge type="tip" text="nowe" /> Trackwall w dev containerze

- Gdy oprogramowanie zabezpieczające spowalnia git i buildy na Windows, wszystko, co dotyka repo, działa w Linuksie w kontenerze, z repo w wolumenie Dockera.
- Z Trackwall korzystasz w przeglądarce albo w aplikacji na pulpicie, przez przekierowany port.

</section>

<section class="slide">

<p class="slide-meta">13 · Gdzie jesteśmy · 0:40</p>

## Dziś i co dalej

- Wczesna wersja: brakuje funkcji, są ostre krawędzie.
- Tylko Copilot CLI. Inny agent może używać narzędzi przez MCP, ale bez sesji i zgód w aplikacji.
- Karta czyta Maven, Gradle, npm, Spring Boot i OpenAPI. Kafki i kolejek nie ma jeszcze w grafie; takie połączenia można dodać ręcznie.
- Jedna osoba, jeden komputer. Windows i macOS, Linux przez kontener.

::: tip Na koniec
Agent przestaje widzieć tylko swój folder. Widzi cały system, tak jak ty.
:::

</section>

[Why Trackwall](/guide/why-trackwall) · [How it works](/guide/how-it-works) · [Security model](/guide/security-model) · [Limits today](/guide/limits) · [Install](/guide/install) (po angielsku)
