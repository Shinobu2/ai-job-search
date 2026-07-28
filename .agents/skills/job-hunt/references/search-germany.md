# Germany search playbook

Use this as a query and coverage checklist, not as a scoring system.

## Search in three waves

1. **Direct roles:** translate the candidate's target into German and English titles. For data-centre/IT support examples: `Data Center Technician`, `Datacenter Techniker`, `IT Support`, `Onsite Support`, `Field Service Technician`, `Remote Hands`, `IT Servicetechniker`.
2. **Adjacent roles:** search transferable work rather than title similarity: `IT Rollout`, `Hardware Technician`, `Break/Fix`, `NOC Technician`, `Network Support`, `Smart Hands`, `Technischer Mitarbeiter`, `Prüftechniker`, `Servicetechniker Rechenzentrum`.
3. **Short-onboarding roles:** combine titles with `Quereinsteiger`, `Berufseinstieg`, `Junior`, `Einarbeitung`, `interne Schulung`, `training provided`, `on-the-job training`, or `keine Ausbildung erforderlich`. Exclude a multi-year `Ausbildung` when the user does not want it, but do not confuse normal paid onboarding with Ausbildung.

Search German spelling variants, abbreviations, nearby cities, region names, airports/industrial parks, and realistic commute radii. Run a focused local wave first, then expand geography only with the user's preference.

Use `hunter` for the three-wave sweep above. Use `sniper` when the user names an employer, source, or exact role; inspect only those exact live adverts. Both modes keep the twelve-posting cap and the same tracker.

## Coverage ladder

1. Run the repository's FreeHire, Bundesagentur Jobsuche, and registered Personio/Greenhouse/Lever employer searches.
2. Rotate through up to four entries from the official manual watchlist printed by `bun run search:employers`. It includes direct data-centre employers and established recruiter pages; prefer the canonical employer advert when one exists.
3. Search `Make it in Germany` and EURES for official cross-border coverage. BA-backed listings can duplicate Jobsuche; deduplicate them.
4. Use LinkedIn Jobs, StepStone, Indeed, XING Jobs, Jobware, stellenanzeigen.de, and Google/Bing job results for discovery. Verify availability and requirements on the employer page before recommending or applying.
5. For sparse results, search ATS domains directly: `site:jobs.personio.de`, `site:boards.greenhouse.io`, `site:jobs.lever.co`, and employer-specific career domains with the role and location.

Do not add a new connector merely to cover another site. Web search and direct-page reading are sufficient until repeated use proves otherwise.

## Review rules

- Collapse duplicates by canonical URL, provider job ID, normalized employer/title/location, and content fingerprint; keep the richest/current source.
- Prefer adverts posted or updated recently. Open the page and mark missing/closed adverts as stale.
- Separate `hard blocker`, `likely fit`, and `needs confirmation` in reasoning, but do not calculate a score.
- Read duties and must-have wording. “Preferred”, “nice to have”, and a long technology list are not automatic blockers.
- Compare salary only when units are compatible. Quote advertised gross hourly/monthly/yearly pay; if estimating net, label it clearly as a rough scenario and request tax assumptions.
- Infer physical load or stress only from evidence such as lifting limits, continuous standing, ticket volume, lone shifts, travel, on-call, production takt, or safety-critical duties. Label an inference.
- Record why a job was skipped so `more` does not return the same poor fit.

## Source basis

- [Bundesagentur Jobsuche](https://www.arbeitsagentur.de/jobsuche/) exposes filters including radius, employment type, freshness, shift/weekend work, pay, and `Quereinstieg möglich`.
- [Make it in Germany job listings](https://www.make-it-in-germany.com/en/working-in-germany/job-listings) is the German government's portal for international applicants and republishes a selected BA pool.
- [EURES](https://eures.europa.eu/jobseekers_en) adds official EU/EEA mobility coverage.
- Official recruiter coverage in the registry includes [Amadeus Fire](https://www.amadeus-fire.de/jobsuche), [DIS AG](https://jobs.de.dis-ag.com/), [Experis](https://www.experis.de/de/search/region/frankfurt), [FERCHAU Frankfurt](https://www.ferchau.com/de/de/ueber-uns/niederlassungen/frankfurt/frankfurt-direct-457), [Randstad](https://www.randstad.de/jobs/hessen/frankfurt-am-main/), [Adecco](https://jobs.de.adecco.com/), [Manpower](https://www.manpower.de/de/search/region/frankfurt), and [DEKRA Arbeit](https://www.dekra-arbeit.de/stellenmarkt). Reading/applying is free; reject third parties asking the candidate for placement, visa or training fees.

Re-check live filters and site availability when searching; source behavior changes.
