"""pipeline/anchors/definitions.py — versioned embedding-anchor definitions (E1).

Spec §2.4 (anchor cluster management) + §4.5/4.11/4.12/4.13 (the construct
metrics). Each construct is defined by ~10 seed phrases that mark a semantic
region in Nomic embedding space. These REPLACE the old keyword/word-list
measures (spec §3.2): insight_word_density → insight_embedding_proximity,
reflective_marker_density → reflective_embedding_density,
sentiment_volatility_within_window → affective_volatility_within_window.

These definitions are NOT secret (they are construct definitions, like a survey
instrument) — they live in version control as plaintext. But because an anchor
change IS a metric change (spec §2.4), every set carries:
  - ANCHOR_VERSION       — bumped whenever any seed set changes
  - seed_content_hash()  — sha256 over the canonical (sorted) seed set, so the
                           pipeline can detect a definition drift and re-embed
                           (the stored anchor vector then no longer matches).

The seed phrases for §4.5 and §4.12 are taken VERBATIM from the spec
(COGNITIVE-MEASUREMENT-SPEC §4.5 / §4.12). The affect anchors (§4.13) and the
reflection-vs-insight split (§4.11 shares the reflection anchor with §4.12 per
the spec) are prototypical expressions chosen to span the construct; they are
labeled experimental and gated by CVP (§2.3) like the rest of the family.
"""

from __future__ import annotations

import hashlib
import json

# Bump whenever ANY seed set below changes. Stored alongside each anchor vector
# (cognitive_anchor_vectors.anchor_version) + each metric row
# (cognitive_metrics_anchor.anchor_version) so reads are provenance-anchored.
ANCHOR_VERSION = "v3-2026-06-24"

# The matryoshka/full dim of the anchor vectors. Messages store embedding_768
# (768-D, L2-normalized at ingest); the §4.5/4.11/4.12/4.13 metrics compute
# cos_sim(message_embedding, anchor) so the anchor MUST live in the SAME space.
# We embed + store at the full 768-D (cosine is dimensionality-consistent).
ANCHOR_DIM = 768

# Construct → ordered list of seed phrases. ~10 per construct (spec §2.4).
SEED_PHRASES: dict[str, list[str]] = {
    # §4.5 insight_embedding_proximity (replaces insight_word_density).
    # Seeds VERBATIM from spec §4.5.
    "insight": [
        "I just realized",
        "now I understand",
        "looking back I see",
        "it occurred to me",
        "I finally see",
        "what I'm noticing",
        "the connection I'm making",
        "this changes how I think about",
        "I hadn't considered",
        "now it makes sense",
    ],
    # §4.12 reflective_embedding_density + §4.11 inner_territory_presence
    # (both use the reflection anchor; spec §4.11 "embedding-space distance to a
    # 'reflection' anchor"). Seeds VERBATIM from spec §4.12.
    "reflection": [
        "looking back",
        "I've been thinking about",
        "what I notice is",
        "on reflection",
        "I wonder if",
        "when I consider",
        "as I examine this",
        "stepping back I see",
        "what strikes me",
        "the pattern I notice",
    ],
    # §4.13 affective_volatility_within_window — positive/negative affect anchor
    # clusters (~10 prototypical emotional expressions each; spec §4.13 step 1).
    "affect_positive": [
        "I feel so happy",
        "this is wonderful",
        "I'm grateful and content",
        "what a joyful moment",
        "I feel hopeful and alive",
        "this brings me peace",
        "I'm excited and energized",
        "I feel loved and safe",
        "everything feels right",
        "I'm proud of this",
    ],
    "affect_negative": [
        "I feel so sad",
        "this is awful",
        "I'm anxious and afraid",
        "what a painful moment",
        "I feel hopeless and tired",
        "this fills me with dread",
        "I'm angry and frustrated",
        "I feel alone and lost",
        "everything feels wrong",
        "I'm ashamed of this",
    ],
}

# ── Inner-state AXES (E2, Tier-1) — bipolar, multilingual ────────────────────
# Each axis is a PAIR of pole constructs (e.g. holding_pos / holding_neg). Unlike
# the single-pole constructs above, an axis is scored as a SIGNED LEAN:
#   lean = mean over window of ( cos(msg, +pole_centroid) − cos(msg, −pole_centroid) )
# (the generalization of affective_volatility's cos_pos−cos_neg; see
# docs/DESIGN-inner-states-engine-2026-06-24.md). Seeds are POOLED across languages
# into one centroid per pole — pooling is the denoiser that makes a single
# multilingual axis transfer to any language (proven: pipeline/lab/inner-states-
# spike.py). Method/evidence: docs/DESIGN-inner-states-embeddings-2026-06-24.md.
#
# AXIS_LANGS documents the languages present; the schema allows growth (more
# phrases / more languages bump ANCHOR_VERSION via the seed-content hash).
AXIS_LANGS = ("en", "es", "de", "ja")

# axis -> pole -> language -> [first-person felt-state phrases]
AXES: dict[str, dict[str, dict[str, list[str]]]] = {
    # §4.x charge — activation/energy (quiet ↔ wired). Layer-1 affect.
    "charge": {
        "+": {
            "en": ["I'm wired and buzzing, full of restless energy",
                   "so much energy, keyed up and activated",
                   "my body is humming, amped and alert",
                   "everything feels fast and intense inside",
                   "I can't sit still, lit up and racing"],
            "es": ["estoy acelerado y vibrando, lleno de energía inquieta",
                   "tanta energía, tenso y activado",
                   "mi cuerpo zumba, excitado y alerta",
                   "todo se siente rápido e intenso por dentro",
                   "no puedo quedarme quieto, encendido y a mil"],
            "de": ["ich bin aufgedreht und vibriere, voller unruhiger Energie",
                   "so viel Energie, angespannt und aktiviert",
                   "mein Körper summt, aufgeladen und wach",
                   "alles fühlt sich schnell und intensiv an",
                   "ich kann nicht stillsitzen, voll aufgeladen"],
            "ja": ["神経が高ぶってざわざわ、落ち着かないエネルギーでいっぱい",
                   "エネルギーが溢れ、張り詰めて活性化している",
                   "体が高鳴り、興奮して鋭敏だ",
                   "内側で何もかもが速くて激しい",
                   "じっとしていられない、高ぶって駆け巡る"],
        },
        "-": {
            "en": ["I'm quiet and low-energy, calm and settled and still",
                   "barely any energy, slow and flat",
                   "my body is heavy and sluggish, powered down",
                   "everything feels slow and muted inside",
                   "I'm depleted and dim, running on empty"],
            "es": ["estoy tranquilo y con poca energía, calmado y quieto",
                   "apenas energía, lento y plano",
                   "mi cuerpo está pesado y aletargado, apagado",
                   "todo se siente lento y apagado por dentro",
                   "estoy agotado y apagado, sin nada en el tanque"],
            "de": ["ich bin ruhig und energielos, gelassen und still",
                   "kaum Energie, langsam und flach",
                   "mein Körper ist schwer und träge, heruntergefahren",
                   "alles fühlt sich langsam und gedämpft an",
                   "ich bin erschöpft und matt, völlig leer"],
            "ja": ["静かでエネルギーが低い、穏やかで落ち着いている",
                   "ほとんどエネルギーがなく、遅くて平坦だ",
                   "体が重くてだるい、電源が落ちたよう",
                   "内側で何もかもが遅く、くぐもっている",
                   "消耗してぼんやり、ガス欠のようだ"],
        },
    },
    # warmth — connection/relational warmth (cut-off ↔ close). Layer-1 affect.
    "warmth": {
        "+": {
            "en": ["I feel close and connected, warm toward them",
                   "tender and open-hearted, near to people I love",
                   "a warm belonging, held and in touch",
                   "I feel affection flowing, soft and connected",
                   "close to others, my heart feels open"],
            "es": ["me siento cercano y conectado, cálido hacia ellos",
                   "tierno y de corazón abierto, cerca de quienes amo",
                   "una pertenencia cálida, sostenido y en contacto",
                   "siento el afecto fluir, suave y conectado",
                   "cerca de los demás, mi corazón se siente abierto"],
            "de": ["ich fühle mich nah und verbunden, warm ihnen gegenüber",
                   "zärtlich und offenherzig, nah bei denen, die ich liebe",
                   "eine warme Zugehörigkeit, gehalten und in Kontakt",
                   "ich spüre Zuneigung fließen, weich und verbunden",
                   "nah bei anderen, mein Herz fühlt sich offen an"],
            "ja": ["近くて繋がっている、彼らに温かさを感じる",
                   "優しく心を開いて、愛する人のそばにいる",
                   "温かな繋がり、支えられ通い合っている",
                   "愛情が流れるのを感じる、柔らかく繋がって",
                   "人と近く、心が開いているのを感じる"],
        },
        "-": {
            "en": ["I feel cut-off and distant, walled away from people",
                   "cold and disconnected, alone behind glass",
                   "no warmth toward anyone, shut off and apart",
                   "I feel estranged, nothing reaching me",
                   "closed and remote, the connection gone cold"],
            "es": ["me siento aislado y distante, amurallado de la gente",
                   "frío y desconectado, solo tras un cristal",
                   "sin calidez hacia nadie, cerrado y aparte",
                   "me siento extraño, nada me alcanza",
                   "cerrado y remoto, la conexión se enfrió"],
            "de": ["ich fühle mich abgeschnitten und distanziert, von Menschen abgeschottet",
                   "kalt und unverbunden, allein hinter Glas",
                   "keine Wärme für irgendwen, verschlossen und abseits",
                   "ich fühle mich entfremdet, nichts erreicht mich",
                   "verschlossen und fern, die Verbindung kalt geworden"],
            "ja": ["切り離されて遠い、人から壁で隔てられている",
                   "冷たく断絶し、ガラスの向こうで独り",
                   "誰にも温かさを感じず、閉じて離れている",
                   "疎外され、何も自分に届かない",
                   "閉じて遠く、繋がりが冷えてしまった"],
        },
    },
    # gatheredness — attentional collectedness (scattered ↔ collected). Layer-2 stance.
    "gatheredness": {
        "+": {
            "en": ["I feel collected and centered, all in one place",
                   "my attention is gathered and steady",
                   "focused and whole, settled into one point",
                   "my mind is unified, here and composed",
                   "gathered and present, nothing pulling me apart"],
            "es": ["me siento centrado y reunido, todo en un lugar",
                   "mi atención está recogida y firme",
                   "concentrado y entero, asentado en un punto",
                   "mi mente está unificada, aquí y serena",
                   "reunido y presente, nada me dispersa"],
            "de": ["ich fühle mich gesammelt und zentriert, ganz an einem Ort",
                   "meine Aufmerksamkeit ist gesammelt und ruhig",
                   "fokussiert und ganz, in einem Punkt verankert",
                   "mein Geist ist geeint, hier und gefasst",
                   "gesammelt und präsent, nichts zerrt an mir"],
            "ja": ["まとまって中心にある、すべてが一つの場所に",
                   "注意が集まって安定している",
                   "集中して全体が、一点に落ち着いている",
                   "心が統一され、ここに静かにある",
                   "まとまって今ここに、何にも引き裂かれない"],
        },
        "-": {
            "en": ["I feel scattered and fragmented, pulled in every direction",
                   "my attention is all over the place, frazzled",
                   "distracted and diffuse, can't gather myself",
                   "my mind is splintered, nothing holds together",
                   "scattered and frantic, spread too thin"],
            "es": ["me siento disperso y fragmentado, tironeado en todas direcciones",
                   "mi atención está por todas partes, agotada",
                   "distraído y difuso, no puedo reunirme",
                   "mi mente está astillada, nada se sostiene",
                   "disperso y frenético, demasiado repartido"],
            "de": ["ich fühle mich zerstreut und fragmentiert, in alle Richtungen gezerrt",
                   "meine Aufmerksamkeit ist überall, zerfranst",
                   "abgelenkt und diffus, ich kann mich nicht sammeln",
                   "mein Geist ist zersplittert, nichts hält zusammen",
                   "zerstreut und hektisch, zu dünn verteilt"],
            "ja": ["散らばって断片的、あらゆる方向に引っ張られる",
                   "注意があちこちに飛んで、すり減っている",
                   "気が散って拡散し、自分をまとめられない",
                   "心が砕けて、何もまとまらない",
                   "散漫で焦り、薄く広がりすぎている"],
        },
    },
    # holding — grip on experience (gripping ↔ letting-be). Layer-2 stance (core).
    "holding": {
        "+": {
            "en": ["I'm letting it be, allowing it without trying to fix it",
                   "I can hold this loosely and let it pass through",
                   "no need to change anything, just letting it rest",
                   "I soften and allow whatever is here to be here",
                   "I'm not grasping, letting it come and go"],
            "es": ["lo dejo estar, permitiéndolo sin intentar arreglarlo",
                   "puedo sostener esto sin apretar y dejar que pase",
                   "no necesito cambiar nada, solo dejarlo descansar",
                   "me ablando y permito que esté lo que está",
                   "no me aferro, lo dejo ir y venir"],
            "de": ["ich lasse es sein, erlaube es, ohne es zu reparieren",
                   "ich kann das locker halten und durchziehen lassen",
                   "nichts muss sich ändern, ich lasse es einfach ruhen",
                   "ich werde weich und erlaube, was da ist",
                   "ich klammere nicht, ich lasse es kommen und gehen"],
            "ja": ["それをそのままにして、直そうとせず許している",
                   "これを軽く持って、通り過ぎるに任せられる",
                   "何も変える必要はない、ただ休ませている",
                   "やわらいで、ここにあるものをここにあらせる",
                   "しがみつかず、来るがままに去るがままにする"],
        },
        "-": {
            "en": ["I'm gripping this hard, I have to fix it right now",
                   "I can't let it go, fighting against how it is",
                   "clenching against this, desperate to make it stop",
                   "I'm clinging and pushing, refusing to allow it",
                   "I have to control this, I can't loosen my grip"],
            "es": ["estoy aferrándome con fuerza, tengo que arreglarlo ya",
                   "no puedo soltarlo, luchando contra cómo es",
                   "me tenso contra esto, desesperado por que pare",
                   "me aferro y empujo, negándome a permitirlo",
                   "tengo que controlar esto, no puedo aflojar"],
            "de": ["ich klammere mich fest, ich muss es sofort reparieren",
                   "ich kann nicht loslassen, kämpfe gegen das, wie es ist",
                   "ich verkrampfe mich dagegen, verzweifelt es zu stoppen",
                   "ich klammere und dränge, weigere mich es zuzulassen",
                   "ich muss das kontrollieren, ich kann nicht lockerlassen"],
            "ja": ["これを強く握りしめ、今すぐ直さなければと思う",
                   "手放せない、現状に抗っている",
                   "これに対して身を固くし、止めたくて必死だ",
                   "しがみつき押し返し、許すことを拒んでいる",
                   "これを制御しなければ、力を緩められない"],
        },
    },
    # noticing — meta-awareness (lost in it ↔ stepped back). Layer-2 stance.
    "noticing": {
        "+": {
            "en": ["I notice I'm having this thought, watching it from a step back",
                   "there's a part of me aware of all this happening",
                   "I can observe the feeling without being swept into it",
                   "I'm witnessing my reaction as it arises",
                   "I see the thought as a thought, a little distance from it"],
            "es": ["noto que estoy teniendo este pensamiento, lo observo desde atrás",
                   "hay una parte de mí consciente de todo esto",
                   "puedo observar la emoción sin que me arrastre",
                   "soy testigo de mi reacción mientras surge",
                   "veo el pensamiento como pensamiento, con algo de distancia"],
            "de": ["ich bemerke diesen Gedanken, beobachte ihn aus etwas Abstand",
                   "ein Teil von mir ist sich all dessen bewusst",
                   "ich kann das Gefühl beobachten, ohne mitgerissen zu werden",
                   "ich bezeuge meine Reaktion, während sie entsteht",
                   "ich sehe den Gedanken als Gedanken, mit etwas Abstand"],
            "ja": ["この考えが起きていると気づき、一歩引いて見ている",
                   "これらすべてに気づいている自分の一部がある",
                   "感情に飲み込まれずに、それを観察できる",
                   "自分の反応が起きるのを見届けている",
                   "考えを考えとして見る、少し距離を置いて"],
        },
        "-": {
            "en": ["I am completely lost in it, no distance at all",
                   "I'm totally swept up, the feeling is all there is",
                   "I'm fused with the thought, it just is reality",
                   "I'm drowning in this, no part of me standing apart",
                   "I can't step back, I am the reaction"],
            "es": ["estoy completamente perdido en ello, sin ninguna distancia",
                   "estoy totalmente arrastrado, la emoción es todo lo que hay",
                   "estoy fundido con el pensamiento, simplemente es la realidad",
                   "me ahogo en esto, ninguna parte de mí se mantiene aparte",
                   "no puedo dar un paso atrás, soy la reacción"],
            "de": ["ich bin völlig darin verloren, gar kein Abstand",
                   "ich bin total mitgerissen, das Gefühl ist alles",
                   "ich bin mit dem Gedanken verschmolzen, er ist einfach Realität",
                   "ich ertrinke darin, kein Teil von mir steht daneben",
                   "ich kann nicht zurücktreten, ich bin die Reaktion"],
            "ja": ["完全にその中に没入し、距離がまったくない",
                   "すっかり飲み込まれ、感情がすべてだ",
                   "考えと一体化し、それがそのまま現実だ",
                   "これに溺れ、離れて立つ自分の部分がない",
                   "一歩引けない、自分がその反応そのものだ"],
        },
    },
    # edges — self-boundary (sharp/contained ↔ soft/merging). Layer-2 stance.
    # The poles use DELIBERATELY DIVERGENT vocabulary (merging/oceanic vs armored/
    # contained), NOT a one-word swap over shared "edges/boundary/separate" framing —
    # that shared framing collapsed the v2 seeds (antonym 0.98, LOO-AUC 0.49, ABSTAIN).
    # Contrastive seeds separate: LOO-AUC 0.84, antonym 0.97 → MEASURABLE
    # (pipeline/lab/edges-rescue-spike.py, 2026-06-24). Still softening-only by intent;
    # the +pole describes loss-of-boundary, NEVER unitive/transcendent experience.
    "edges": {
        "+": {
            "en": ["I melt into everything around me, no inside or outside",
                   "a vast oceanic openness, spread out into the whole room",
                   "porous and flowing, the world passes right through me",
                   "I expand outward and lose where I begin",
                   "dissolved into the space, mingling with all of it",
                   "boundless and diffuse, part of one single field"],
            "es": ["me derrito en todo lo que me rodea, sin dentro ni fuera",
                   "una vasta apertura oceánica, extendido por toda la sala",
                   "poroso y fluyendo, el mundo me atraviesa",
                   "me expando hacia afuera y pierdo dónde empiezo",
                   "disuelto en el espacio, mezclándome con todo",
                   "ilimitado y difuso, parte de un solo campo"],
            "de": ["ich verschmelze mit allem um mich, kein Innen oder Außen",
                   "eine weite ozeanische Offenheit, ausgebreitet über den ganzen Raum",
                   "durchlässig und fließend, die Welt strömt durch mich hindurch",
                   "ich dehne mich aus und verliere, wo ich anfange",
                   "aufgelöst in den Raum, verschmolzen mit allem",
                   "grenzenlos und diffus, Teil eines einzigen Feldes"],
            "ja": ["周りのすべてに溶け込み、内も外もない",
                   "広大で大海のような開け、部屋全体に広がる",
                   "透き通って流れ、世界が私を通り抜ける",
                   "外へと広がり、自分の始まりが分からなくなる",
                   "空間に溶け、すべてと混ざり合う",
                   "果てしなく拡散し、一つの場の一部になる"],
        },
        "-": {
            "en": ["I am a sealed unit, contained entirely within my skin",
                   "armored and gathered tightly inside myself",
                   "a hard discrete shell, nothing gets through",
                   "compact and solid, a single thing standing alone",
                   "walled in, the room stays firmly outside me",
                   "enclosed and impermeable, held within my own outline"],
            "es": ["soy una unidad sellada, contenido enteramente bajo mi piel",
                   "blindado y recogido firmemente dentro de mí",
                   "una cáscara dura y discreta, nada la atraviesa",
                   "compacto y sólido, una sola cosa que está sola",
                   "amurallado, la sala queda firmemente afuera de mí",
                   "cerrado e impermeable, sostenido dentro de mi propio contorno"],
            "de": ["ich bin eine versiegelte Einheit, ganz in meiner Haut enthalten",
                   "gepanzert und fest in mir gesammelt",
                   "eine harte, abgegrenzte Schale, nichts kommt hindurch",
                   "kompakt und fest, ein einzelnes Ding für sich allein",
                   "ummauert, der Raum bleibt fest außerhalb von mir",
                   "verschlossen und undurchlässig, in meinem eigenen Umriss gehalten"],
            "ja": ["私は密閉された単体、皮膚の内にすべて収まっている",
                   "装甲され、内側に固くまとまっている",
                   "硬く独立した殻、何も通さない",
                   "ぎゅっと固く、独りで立つ一つのもの",
                   "壁に囲まれ、部屋は私の外にとどまる",
                   "閉じて不透過、自分の輪郭の内に保たれている"],
        },
    },
    # kusala — skillfulness / wholesome ↔ unwholesome (Buddhist kusala/akusala).
    # DERIVED + EVALUATIVE. Seeds are TONE-BALANCED (each pole mixes pleasant &
    # unpleasant) so the axis isolates skillfulness, not feeling-tone — proven ⊥ tone
    # (cos 0.19), AUC 0.83 (pipeline/lab/kusala-spike.py). Surfaced (when CVP passes)
    # ONLY as a functional direction / three-roots, NEVER an absolute moral grade.
    "kusala": {
        "+": {  # wholesome: lovingkindness/generosity/contentment + compassionate-grief/courage
            "en": ["a warm open-hearted gladness, wishing them well",
                   "content and at ease, generous toward everyone",
                   "calm kind goodwill, glad to give freely",
                   "it aches, but I meet the grief with patient tenderness",
                   "afraid, yet I face it with steady honest courage"],
            "es": ["una alegría cálida y abierta, deseándoles el bien",
                   "contento y en paz, generoso con todos",
                   "buena voluntad serena y amable, feliz de dar",
                   "duele, pero acojo el duelo con paciente ternura",
                   "con miedo, pero lo enfrento con valor firme y honesto"],
            "de": ["eine warme, offenherzige Freude, ich wünsche ihnen Gutes",
                   "zufrieden und gelassen, großzügig zu allen",
                   "ruhiges, freundliches Wohlwollen, gern gebe ich",
                   "es schmerzt, doch ich begegne der Trauer mit geduldiger Zärtlichkeit",
                   "voller Angst, doch ich stelle mich ihr mit ruhigem Mut"],
            "ja": ["温かく開かれた喜び、彼らの幸せを願う",
                   "満ち足りて穏やか、誰にでも寛大だ",
                   "静かで優しい善意、惜しみなく与えられる",
                   "胸が痛むが、悲しみを忍耐強い優しさで受けとめる",
                   "怖いが、揺るがぬ誠実な勇気で向き合う"],
        },
        "-": {  # unwholesome: greed/malice/vengeance (pleasant) + resentment/craving (unpleasant)
            "en": ["a greedy thrill as I indulge, craving more and more",
                   "smug pleasure gloating over my rival's failure",
                   "the sweet rush of revenge, savoring their pain",
                   "burning with resentment and bitter ill-will",
                   "tormented by craving I can't satisfy, gnawing at me"],
            "es": ["una emoción codiciosa al darme el gusto, ansiando más y más",
                   "un placer engreído regodeándome en el fracaso de mi rival",
                   "la dulce descarga de la venganza, saboreando su dolor",
                   "ardiendo de resentimiento y amarga mala voluntad",
                   "atormentado por un ansia que no puedo saciar, royéndome"],
            "de": ["ein gieriger Rausch beim Schwelgen, ich will mehr und mehr",
                   "selbstgefällige Lust, ich weide mich am Scheitern meines Rivalen",
                   "der süße Schub der Rache, ich koste ihren Schmerz aus",
                   "brennend vor Groll und bitterem Übelwollen",
                   "gequält von einer Gier, die ich nicht stillen kann, nagend"],
            "ja": ["貪るような興奮で耽り、もっともっと欲しがる",
                   "ライバルの失敗をほくそ笑む、得意げな快感",
                   "復讐の甘い高揚、彼らの痛みを味わう",
                   "恨みと苦い悪意に燃えている",
                   "満たせない渇望に苛まれ、心をむしばまれる"],
        },
    },
}

# axis -> (pos_construct, neg_construct, layer, is_kusala). `tone` REUSES the existing
# affect_positive/affect_negative constructs (no duplicate seeds; tone_lean = the MEAN
# of what affective_volatility takes the STDDEV of). The rest get new pole constructs
# folded into SEED_PHRASES below.
AXIS_META: dict[str, dict] = {
    "tone": {"pos": "affect_positive", "neg": "affect_negative", "layer": 1, "kusala": False},
}
for _axis, _poles in AXES.items():
    _pos_c, _neg_c = f"{_axis}_pos", f"{_axis}_neg"
    # Fold each pole's multilingual phrases into one flat seed list (POOLED centroid).
    SEED_PHRASES[_pos_c] = [p for lang in AXIS_LANGS for p in _poles["+"][lang]]
    SEED_PHRASES[_neg_c] = [p for lang in AXIS_LANGS for p in _poles["-"][lang]]
    AXIS_META[_axis] = {
        "pos": _pos_c, "neg": _neg_c,
        "layer": ("derived" if _axis == "kusala" else (2 if _axis in
                  ("gatheredness", "holding", "noticing", "edges") else 1)),
        "kusala": _axis == "kusala",
    }

# Stable axis order (metric-column + iteration order).
AXES_ORDER = ("tone", "charge", "warmth", "gatheredness",
              "holding", "noticing", "edges", "kusala")
# The metric column each axis writes (cognitive_metrics_anchor + CVP registry).
AXIS_LEAN_COLUMN = {a: f"{a}_lean" for a in AXES_ORDER}


# Canonical construct order (PRIMARY KEY component + stable iteration).
CONSTRUCTS = tuple(SEED_PHRASES.keys())

# The Nomic task to use when embedding the seed phrases. Anchors are "documents"
# defining a region (matches how message embeddings are produced at ingest). The
# embed-service HTTP API takes task ∈ {"query","document"} (TASK_PREFIXES in
# pipeline/embed-service.py). The embedder layer applies the prefix.
ANCHOR_EMBED_TASK = "document"


def seed_content_hash(construct: str) -> str:
    """Stable sha256 over a construct's seed set (order-independent).

    A change to ANY seed phrase changes the hash → the pipeline detects the drift
    (stored hash != recomputed hash) and re-embeds. Order-independent (sorted) so
    a pure reordering of equivalent seeds is NOT treated as a metric change.
    """
    seeds = SEED_PHRASES[construct]
    canonical = json.dumps(sorted(seeds), ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def all_content_hashes() -> dict[str, str]:
    """{construct: seed_content_hash} for every construct."""
    return {c: seed_content_hash(c) for c in CONSTRUCTS}


# ─────────────────────────────────────────────────────────────────────────────
# Inner-States Atlas · Phase A — Affective core (Layer 1)
# Authored 2026-06-21 per docs/INNER-STATES-ATLAS-SPEC.md (scope: valence +
# arousal circumplex + Plutchik-8; surfacing = neutral labels).
#
# DELIBERATELY NOT WIRED. These constructs are kept OUT of SEED_PHRASES /
# CONSTRUCTS / ANCHOR_VERSION so the live pipeline and the cognitive_metrics_anchor
# schema are UNCHANGED by this commit (fail-safe: nothing computes on them yet).
# Activation is a separate, verify-gated step (see spec §8 / the build checklist):
#   1) migration: cognitive_metrics_atlas_state (per-window, encrypted scalars)
#   2) pipeline: compute per-message cos_sim → valence/arousal axes + Plutchik
#      proximities; aggregate per window
#   3) metricsCatalog.ts: new family `affective-core`, rigor='experimental',
#      surfaced=false  +  src/metrics/contracts.js preferred_vocab entry
#   4) merge ATLAS_SEED_PHRASES into SEED_PHRASES, bump ANCHOR_VERSION, re-embed
#   5) `npm run verify:*` to VERDICT: GO before surfacing
#
# Honesty (spec §6): these are PROXIMITY/LEANING signals, never "emotion detected"
# and never clinical. Internal keys are precise; `surface_label` is the neutral
# user-facing wording.
ATLAS_LAYER = "affective-core"

ATLAS_SEED_PHRASES: dict[str, list[str]] = {
    # ── Circumplex axis 1: VALENCE (pleasant ↔ unpleasant), kept as far as
    # possible independent of arousal. Decomposes the old affect_positive/
    # affect_negative bundle into a clean bipolar axis.
    "valence_positive": [
        "this feels good",
        "I feel pleasant right now",
        "something nice is happening",
        "I like how this is",
        "it feels warm and right",
        "I'm content with this",
        "there's a sweetness to this",
        "I feel good about it",
        "I welcome this",
        "it feels positive",
        "this sits well with me",
        "I'm at ease with how things are",
    ],
    "valence_negative": [
        "this feels bad",
        "I feel unpleasant right now",
        "something is wrong here",
        "I don't like how this is",
        "it feels cold and off",
        "I'm troubled by this",
        "there's a bitterness to this",
        "I feel bad about it",
        "I recoil from this",
        "it feels negative",
        "this sits badly with me",
        "I'm uneasy with how things are",
    ],
    # ── Circumplex axis 2: AROUSAL (activated ↔ deactivated), independent of
    # valence (high arousal can be pleasant OR unpleasant, and likewise low).
    "arousal_high": [
        "my heart is racing",
        "I can't sit still",
        "everything feels intense and fast",
        "my mind is racing",
        "I feel charged up",
        "there's so much energy in me",
        "I'm on edge",
        "I feel keyed up",
        "it's overwhelming and loud",
        "I'm buzzing",
        "I feel a surge inside",
        "I'm wired and restless",
    ],
    "arousal_low": [
        "I feel calm and still",
        "everything is quiet and slow",
        "I feel settled",
        "I'm relaxed and at ease",
        "my mind is quiet",
        "I feel drowsy and heavy",
        "there's a deep stillness",
        "I feel mellow",
        "things feel slow and soft",
        "I'm winding down",
        "I feel serene",
        "a quiet calm settled over me",
    ],
    # ── Plutchik-8 primary emotions (categorical layer over the circumplex).
    "plutchik_joy": [
        "I feel pure joy",
        "my heart is light",
        "I'm delighted",
        "this fills me with happiness",
        "I feel like celebrating",
        "everything feels bright",
        "I'm overjoyed",
        "what a happy feeling",
        "I feel elated",
        "joy bubbles up in me",
    ],
    "plutchik_trust": [
        "I feel I can rely on this",
        "I trust them completely",
        "I feel safe with you",
        "this feels dependable",
        "I can let my guard down",
        "I believe in them",
        "I feel held and secure",
        "there's a deep trust here",
        "I feel confident in this",
        "I can count on this",
    ],
    "plutchik_fear": [
        "I'm afraid of what's coming",
        "this scares me",
        "I feel a creeping dread",
        "I'm frightened",
        "something feels threatening",
        "I'm scared this will go wrong",
        "fear grips me",
        "I feel unsafe",
        "I'm bracing for the worst",
        "a chill of fear runs through me",
    ],
    "plutchik_surprise": [
        "I did not see that coming",
        "what a shock",
        "I'm completely taken aback",
        "this caught me off guard",
        "I can't believe it happened",
        "it came out of nowhere",
        "I'm stunned",
        "that was unexpected",
        "it startled me",
        "my jaw dropped",
    ],
    "plutchik_sadness": [
        "I feel so sad",
        "a heaviness sits in my chest",
        "I feel like crying",
        "I'm grieving this",
        "everything feels grey",
        "I feel a deep sorrow",
        "I miss what's gone",
        "I feel low and tearful",
        "a wave of sadness moves through me",
        "my heart aches",
    ],
    "plutchik_disgust": [
        "this repulses me",
        "I feel sick about it",
        "it's revolting",
        "I'm disgusted",
        "I want to turn away from this",
        "it leaves a bad taste",
        "how distasteful",
        "I feel contempt for this",
        "it's vile",
        "I recoil in disgust",
    ],
    "plutchik_anger": [
        "I'm furious",
        "this makes my blood boil",
        "I'm so angry",
        "I feel rage rising",
        "how dare they",
        "I'm fed up and irritated",
        "I want to lash out",
        "this is infuriating",
        "I'm seething",
        "resentment burns in me",
    ],
    "plutchik_anticipation": [
        "I can't wait for this",
        "I'm looking forward to it",
        "I feel the build-up",
        "something is coming and I'm ready",
        "I'm eager for what's next",
        "I'm anticipating it keenly",
        "the suspense is building",
        "I'm preparing for what's ahead",
        "I sense it approaching",
        "I'm on the edge of my seat with expectation",
    ],
}

# construct → {layer, group, axis/pole, surface_label}. surface_label is the
# NEUTRAL user-facing wording (decision D3); the key stays precise.
ATLAS_META: dict[str, dict[str, str]] = {
    "valence_positive": {"layer": ATLAS_LAYER, "group": "valence", "pole": "positive", "surface_label": "positive tone"},
    "valence_negative": {"layer": ATLAS_LAYER, "group": "valence", "pole": "negative", "surface_label": "negative tone"},
    "arousal_high": {"layer": ATLAS_LAYER, "group": "arousal", "pole": "high", "surface_label": "activated"},
    "arousal_low": {"layer": ATLAS_LAYER, "group": "arousal", "pole": "low", "surface_label": "calm"},
    "plutchik_joy": {"layer": ATLAS_LAYER, "group": "plutchik", "pole": "", "surface_label": "joy"},
    "plutchik_trust": {"layer": ATLAS_LAYER, "group": "plutchik", "pole": "", "surface_label": "trust"},
    "plutchik_fear": {"layer": ATLAS_LAYER, "group": "plutchik", "pole": "", "surface_label": "fear"},
    "plutchik_surprise": {"layer": ATLAS_LAYER, "group": "plutchik", "pole": "", "surface_label": "surprise"},
    "plutchik_sadness": {"layer": ATLAS_LAYER, "group": "plutchik", "pole": "", "surface_label": "sadness"},
    "plutchik_disgust": {"layer": ATLAS_LAYER, "group": "plutchik", "pole": "", "surface_label": "disgust"},
    "plutchik_anger": {"layer": ATLAS_LAYER, "group": "plutchik", "pole": "", "surface_label": "anger"},
    "plutchik_anticipation": {"layer": ATLAS_LAYER, "group": "plutchik", "pole": "", "surface_label": "anticipation"},
}

ATLAS_CONSTRUCTS = tuple(ATLAS_SEED_PHRASES.keys())


# ─────────────────────────────────────────────────────────────────────────────
# Character Resonance · user-vector derivation — the 8 COGNITIVE DIMENSIONS
# Authored 2026-06-21 per docs/CHARACTER-RESONANCE-DESIGN.md §1. These let us
# derive a user's 8-D cognitive vector FROM TEXT so it can be matched against the
# 2,000-figure atlas (portal-app/src/lib/curious/characterResonance.ts), which is
# authored on exactly these 8 axes. Each axis has a LOW pole (0.0) and a HIGH
# pole (1.0) seed cluster; the user's score on axis d is the relative proximity
# of their writing centroid:
#
#     score_d = clamp01( 0.5 + (cos(user, high_d) - cos(user, low_d)) / 2 )
#
# Computed at multiple granularities (overall / per-realm / per-window) to feed
# resonanceMatch / matchAreas / matchTimeline (design §2-§3).
#
# DELIBERATELY NOT WIRED (same discipline as the affective-core atlas block):
# kept out of SEED_PHRASES/CONSTRUCTS/ANCHOR_VERSION so the live pipeline is
# unchanged. Activation = migration (user_cognitive_vector, encrypted) + pipeline
# (centroid → pole proximity → 8-D) + verify gate. Honesty: a proximity-derived
# ESTIMATE surfaced as "leans toward", never a measured trait (CLAUDE.md §7).
COGNITIVE_DIM_ANCHORS: dict[str, dict[str, list[str]]] = {
    "integrative_complexity": {  # 0 sees-clearly ↔ 1 holds-paradox
        "low": ["it's simple, really", "there's a clear right answer here", "I see it in black and white",
                "either it works or it doesn't", "the answer is obvious to me", "it's straightforward",
                "one side is just correct", "I don't see why people complicate this"],
        "high": ["both things can be true at once", "I keep holding two opposing views", "it's more complicated than it looks",
                 "on the one hand, but on the other", "I can see why each side has a point", "it depends how you frame it",
                 "the tension between them is the point", "I'm holding the contradiction"],
    },
    "abstraction_level": {  # 0 concrete ↔ 1 systems
        "low": ["let me give you the specific details", "here's exactly what happened", "concretely, step by step",
                "I focus on the practical particulars", "just the facts of this case", "I think in examples",
                "what does this mean in practice", "the nuts and bolts of it"],
        "high": ["zooming out to the bigger pattern", "this is really about the underlying structure", "in the abstract",
                 "the general principle here is", "I think in systems and models", "at a higher level of abstraction",
                 "the deeper framework underneath", "how the whole thing fits together"],
    },
    "epistemic_breadth": {  # 0 specialist ↔ 1 polymath
        "low": ["in my field specifically", "I go deep on this one thing", "my narrow area of expertise",
                "I specialize in just this", "drilling deep into my domain", "I know this one thing thoroughly",
                "staying within my discipline", "this is my one subject"],
        "high": ["connecting ideas across fields", "this reminds me of something in a different domain", "I read widely across everything",
                 "drawing on art and science together", "I'm curious about many subjects at once", "borrowing a concept from another discipline",
                 "cross-pollinating ideas", "I range across many areas"],
    },
    "systematic_rigor": {  # 0 intuition ↔ 1 verifies
        "low": ["I just have a gut feeling about this", "it feels right to me", "I trust my instinct here",
                "I can't explain why but I know", "intuitively, I sense that", "I go with my hunch",
                "something tells me", "I feel my way through it"],
        "high": ["let me check the evidence first", "I want to verify this carefully", "what does the data actually show",
                 "I tested it methodically", "step by step, rigorously", "let me double-check the reasoning",
                 "I need proof before I believe it", "I work through it systematically"],
    },
    "creative_latitude": {  # 0 conventional ↔ 1 recombines
        "low": ["I'll do it the standard way", "the usual approach is fine", "I follow the established method",
                "by the book", "the conventional wisdom works", "I stick to what's proven",
                "the normal way of doing this", "tried and tested"],
        "high": ["what if we combined these in a new way", "let me try something unconventional", "I want to reinvent this",
                 "a wild idea just occurred to me", "mixing things that don't usually go together", "an original take on it",
                 "let me break the usual pattern", "I love novel combinations"],
    },
    "metacognitive_awareness": {  # 0 instinct ↔ 1 monitors
        "low": ["I just act without overthinking", "I don't really analyze my own thinking", "I react in the moment",
                "I don't question how I got there", "I just do what comes naturally", "I trust the flow",
                "I'm not one to overanalyze myself", "I don't dwell on my own process"],
        "high": ["I notice how my mind is working", "I'm aware of my own thought process", "I catch myself when I'm biased",
                 "I'm reflecting on how I reason", "watching my own thinking unfold", "I question my assumptions",
                 "I'm conscious of why I think this", "I observe my mental habits"],
    },
    "agency": {  # 0 receptive ↔ 1 directs
        "low": ["things just happen to me", "I'm waiting to see how it unfolds", "I go along with what comes",
                "it's out of my hands", "I let life take its course", "I respond to whatever arrives",
                "I'm carried by circumstances", "I receive what's given"],
        "high": ["I'm making this happen", "I take charge of the situation", "I decided and I acted",
                 "I'm driving this forward", "I set the direction", "I take initiative",
                 "I'll shape the outcome I want", "I shape my own path"],
    },
    "emotional_register": {  # 0 analytical ↔ 1 emotionally-present
        "low": ["let me look at this objectively", "setting feelings aside", "analytically speaking",
                "I keep emotion out of it", "just the logic of the matter", "dispassionately",
                "I detach and assess", "coolly evaluating"],
        "high": ["I feel this deeply", "my heart is in this", "it moves me",
                 "I'm so emotionally invested", "I feel it in my body", "this stirs something in me",
                 "I'm overwhelmed with feeling", "it touches me profoundly"],
    },
}

# Canonical axis order — MUST match COGNITIVE_AXES in characterResonance.ts.
COGNITIVE_DIM_ORDER = tuple(COGNITIVE_DIM_ANCHORS.keys())
