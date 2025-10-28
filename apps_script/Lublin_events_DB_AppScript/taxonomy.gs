//Create the three tabs with starter data,seeds useful rules and aliases, and protects you from typos in match_type.

function setupTaxonomy() {
  const ss = SpreadsheetApp.getActive();

  // --- taxonomy_map ---
  const map = ss.getSheetByName('taxonomy_map') || ss.insertSheet('taxonomy_map');
  map.clear();
  map.getRange(1,1,1,6).setValues([['source','source_key','source_label','match_type','canonical','notes']]);

  const seed = [
    // Global EXPLICIT matches (exact)
    ['*','', 'dla dzieci',          'exact',   'kids',       'PL: for kids'],
    ['*','', 'dzieci',              'exact',   'kids',       'PL: kids'],
    ['*','', 'rodzinne',            'exact',   'family',     'PL: family'],


    // Global CONTAINS rules (broad stems, keep lowercase, no diacritics)
    ['*','', 'dziec',               'contains','kids',       'stem'],
    ['*','', 'rodzin',              'contains','family',     'stem'],
    ['*','', 'warsztat',            'contains','workshop',   'warsztaty/warsztat'],
    ['*','', 'szkolen',             'contains','education',  'szkolenie/szkolenia'],
    ['*','', 'spektakl',            'contains',   'theatre',    ''],
    ['*','', 'film',                'contains',   'film',       ''],
    ['*','', 'kino',                'contains',   'film',       ''],
    ['*','', 'koncert',             'contains','music',      ''],
    ['*','', 'muzyk',               'contains','music',      ''],
    ['*','', 'teatr',               'contains','theatre',    ''],
    ['*','', 'opera',               'contains','theatre',    'teatr_opera'],
    ['*','', 'balet',               'contains','theatre',    'teatr_balet'],
    ['*','', 'musical',             'contains','theatre',    'teatr_musikal'],
    ['*','', 'wystaw',              'contains','exhibition', 'wystawa/wystawy'],
    ['*','', 'festiwal',            'contains','festival',   ''],
    ['*','', 'jarmark',             'contains','market',     'or festival'],
    ['*','', 'targi',               'contains','market',     'trade fair'],
    ['*','', 'muzeum',              'contains','museum',     ''],
    ['*','', 'spacer',              'contains','outdoor',    'walk'],
    ['*','', 'zwiedz',              'contains','outdoor',    'tour/visiting'],
    ['*','', 'wyciecz',             'contains','outdoor',    'trip/excursion'],
    ['*','', 'sport',               'contains','sport',      ''],
    ['*','', 'biznes',              'contains','business',   ''],
    ['*','', 'techn',               'contains','tech',       'tech/technology/IT'],
    ['*','', 'network',             'contains','networking', ''],
    ['*','', 'wyklad',              'contains','talk',       'wykład'],
    ['*','', 'prelekc',             'contains','talk',       ''],
    ['*','', 'spotkan',           'contains','talk',       'author talk'],
    ['*','', 'debat',               'contains','talk',       'debata talk'],
    ['*','', 'dyskus',              'contains','talk',       'dyskusja talk'],
    ['*','', 'spolecz',             'contains','community',  'społecz- stem'],
    ['*','', 'charyta',             'contains','charity',    ''],
    // Source-specific examples (add when you discover site IDs/labels)
    // ['lublin.eu','42','dla dzieci','exact','kids','ID → kids'],
    // ['zoom.lublin.pl','','koncert','exact','music','static label']
  ];
  map.getRange(2,1,seed.length,6).setValues(seed);

  // Freeze + simple validation for match_type
  map.setFrozenRows(1);
  const dv = SpreadsheetApp.newDataValidation().requireValueInList(['exact','contains','regex'], true).build();
  map.getRange(2,4,map.getMaxRows()-1,1).setDataValidation(dv);

  // --- taxonomy_alias ---
  const alias = ss.getSheetByName('taxonomy_alias') || ss.insertSheet('taxonomy_alias');
  alias.clear();
  alias.getRange(1,1,1,2).setValues([['alias','canonical']]);
  const aliasSeed = [
    ['dla dzieci','kids'], ['dzieci','kids'], ['kids','kids'],
    ['rodzinne','family'], ['family','family'],
    ['warsztaty','workshop'], ['warsztat','workshop'],
    ['szkolenie','education'], ['szkolenia','education'],
    ['koncert','music'], ['koncerty','music'], ['muzyka','music'],
    ['teatr','theatre'], ['spektakl','theatre'],
    ['film','film'], ['kino','film'],
    ['wystawa','exhibition'], ['wystawy','exhibition'],
    ['festiwal','festival'], ['jarmark','market'], ['targi','market'],
    ['muzeum','museum'],
    ['spacer','outdoor'], ['wycieczka','outdoor'], ['zwiedzanie','outdoor'],
    ['sport','sport'], ['biegi','sport'],
    ['biznes','business'], ['it','tech'], ['technologia','tech'], ['ai','tech'],
    ['networking','networking'],
    ['wykład','talk'], ['prelekcja','talk'], ['spotkanie autorskie','talk'],
    ['społeczność','community'], ['charytatywne','charity']
  ];
  alias.getRange(2,1,aliasSeed.length,2).setValues(aliasSeed);
  alias.setFrozenRows(1);

  // --- taxonomy_unmapped (empty log) ---
  const unm = ss.getSheetByName('taxonomy_unmapped') || ss.insertSheet('taxonomy_unmapped');
  unm.clear();
  unm.getRange(1,1,1,3).setValues([['source','raw_label','count']]);
  unm.setFrozenRows(1);
}
