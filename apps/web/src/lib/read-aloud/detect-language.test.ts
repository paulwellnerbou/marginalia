import { describe, expect, test } from 'bun:test';
import { detectLanguage } from './detect-language.js';

// A short paragraph each — about what a heading plus an opening
// paragraph gives the detector on a real document.
const SAMPLES: Record<string, string> = {
  en: 'This is the first chapter of the report. It explains what the team has built and why the changes were necessary for the users who work with it every day.',
  de: 'Dies ist das erste Kapitel des Berichts. Es erklärt, was das Team gebaut hat und warum die Änderungen für die Menschen nötig sind, die jeden Tag damit arbeiten.',
  fr: 'Ceci est le premier chapitre du rapport. Il explique ce que l’équipe a construit et pourquoi les changements étaient nécessaires pour les personnes qui travaillent avec cet outil.',
  es: 'Este es el primer capítulo del informe. Explica lo que el equipo ha construido y por qué los cambios eran necesarios para las personas que trabajan con él todos los días.',
  it: 'Questo è il primo capitolo del rapporto. Spiega che cosa ha costruito la squadra e perché le modifiche sono state necessarie per le persone che lo usano ogni giorno.',
  pt: 'Este é o primeiro capítulo do relatório. Ele explica o que a equipe construiu e por que as mudanças foram necessárias para as pessoas que trabalham com ele todos os dias.',
  nl: 'Dit is het eerste hoofdstuk van het rapport. Het legt uit wat het team heeft gebouwd en waarom de wijzigingen nodig waren voor de mensen die er elke dag mee werken.',
  sv: 'Det här är det första kapitlet i rapporten. Det förklarar vad teamet har byggt och varför ändringarna var nödvändiga för de personer som arbetar med det varje dag.',
  da: 'Dette er det første kapitel af rapporten. Det forklarer hvad holdet har bygget, og hvorfor ændringerne var nødvendige for de mennesker, som arbejder med det hver dag.',
  nb: 'Dette er det første kapittelet av rapporten. Det forklarer hva teamet har bygget, og hvorfor endringene var nødvendige for menneskene som jobber med det hver dag.',
  pl: 'To jest pierwszy rozdział raportu. Wyjaśnia, co zespół zbudował i dlaczego zmiany były potrzebne dla ludzi, którzy pracują z nim każdego dnia.',
  cs: 'Toto je první kapitola zprávy. Vysvětluje, co tým postavil a proč byly změny nutné pro lidi, kteří s ním pracují každý den, a také jak je používat.',
  sk: 'Toto je prvá kapitola správy. Vysvetľuje, čo tím postavil a prečo boli zmeny potrebné pre ľudí, ktorí s ním pracujú každý deň, a tiež ako ich používať.',
  tr: 'Bu raporun ilk bölümüdür. Ekibin ne inşa ettiğini ve değişikliklerin her gün onunla çalışan insanlar için neden gerekli olduğunu açıklar, ancak daha çok şey var.',
  ru: 'Это первая глава отчёта. Она объясняет, что построила команда и почему изменения были нужны для людей, которые работают с ним каждый день.',
  uk: 'Це перший розділ звіту. Він пояснює, що побудувала команда і чому зміни були потрібні для людей, які працюють з ним щодня, та як їх використовувати.',
  el: 'Αυτό είναι το πρώτο κεφάλαιο της αναφοράς.',
  ja: 'これは報告書の最初の章です。チームが何を作ったのかを説明します。',
  zh: '这是报告的第一章。它解释了团队建造了什么以及为什么需要这些改变。',
  ko: '이것은 보고서의 첫 번째 장입니다.',
};

describe('detectLanguage', () => {
  for (const [lang, text] of Object.entries(SAMPLES)) {
    test(`recognizes ${lang}`, () => {
      expect(detectLanguage(text)).toBe(lang);
    });
  }

  test('gives up on text too short to call', () => {
    expect(detectLanguage('Marginalia')).toBeNull();
    expect(detectLanguage('')).toBeNull();
    expect(detectLanguage('42 — 17')).toBeNull();
  });

  test('is not thrown by English terms inside a German text', () => {
    const text =
      'Wir haben das Feature im Backend deployed. Der Pull Request ist gemerged, und die Tests laufen auf der Pipeline, aber das Monitoring fehlt noch.';
    expect(detectLanguage(text)).toBe('de');
  });
});
