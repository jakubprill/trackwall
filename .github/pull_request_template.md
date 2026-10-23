## Co się zmienia

<!-- Dla użytkownika Pitwall: jak było, jak jest. Przy zmianie wewnętrznej: co i gdzie. -->

## Dlaczego

## Jak

<!-- Najważniejsze decyzje w kodzie. Nowa decyzja architektoniczna: numer ADR w docs/architecture.md §12. -->

## Jak sprawdzone

<!-- Komendy z Definition of done (AGENTS.md), testy dodane w tym PR, co uruchomiono na Windowsie i macOS. -->

Do sprawdzenia ręcznie:

## Review przed PR

<!-- Rundy: thermo-nuclear, /code-review max, mattpocock-skills:code-review. Co poprawiono, co odrzucono i dlaczego. -->

## Definition of done

- [ ] Test na najtańszym poziomie, który udowadnia zmianę (poprawka błędu: test, który bez niej nie przechodzi)
- [ ] Kod zależny od systemu sprawdzony na Windowsie i macOS (CI albo lista „do sprawdzenia ręcznie”)
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` lokalnie; przy zmianach w desktopie i pakowaniu także `pnpm build:desktop`, `cargo test`, `pnpm portable`
- [ ] Dokumentacja w tym PR: `docs/architecture.md`, `CONTEXT.md`, `README.md`, `docs/release.md`, jeśli zmiana ich dotyczy
- [ ] Nic firmowego w kodzie, testach, fixture'ach i commitach
- [ ] Review przed PR zrobione do czystej rundy
