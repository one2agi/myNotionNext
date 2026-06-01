/**
 * 知行合一 · 产品落地页
 * 基于 starter 主题定制
 */
const CONFIG = {
  // ===== LOGO =====
  STARTER_LOGO: '',
  STARTER_LOGO_WHITE: '',

  // ===== 导航栏按钮 =====
  STARTER_NAV_BUTTON_1_TEXT: '',
  STARTER_NAV_BUTTON_1_URL: '/sign-in',
  STARTER_NAV_BUTTON_2_TEXT: '',
  STARTER_NAV_BUTTON_2_URL: '/sign-up',

  // ===== HERO 英雄区 =====
  STARTER_HERO_ENABLE: true,
  STARTER_HERO_TITLE_1: '给现代知识工作者的',
  STARTER_HERO_TITLE_2: '人生操作系统',
  STARTER_HERO_BUTTON_1_TEXT: '了解系统',
  STARTER_HERO_BUTTON_1_URL:
    'https://faize.notion.site/4ee6b996aa5e82a18f5a01157efe93b6?source=copy_link',
  STARTER_HERO_BUTTON_2_TEXT: '看演示站',
  STARTER_HERO_BUTTON_2_URL: 'https://www.faiz-world.com',
  STARTER_HERO_BUTTON_2_ICON: '',
  STARTER_HERO_PREVIEW_IMAGE: '/images/starter/hero/hero-image.webp',
  STARTER_HERO_BANNER_IMAGE: '',

  // ===== FEATURES 特性区 =====
  STARTER_FEATURE_ENABLE: true,
  STARTER_FEATURE_TITLE: '为什么不一样',
  STARTER_FEATURE_TEXT_1: '不是另一个 GTD 模板',
  STARTER_FEATURE_TEXT_2:
    '「知行合一」从失败出发：系统太多，真正跑起来的太少。<br/>原因不是懒——是大多数系统没有解决三个根本问题：<br/>维护负担太重 · 成长看不见 · 做完了没有反馈。',

  STARTER_FEATURE_1_TITLE_1: '游戏化是科学，不是装饰',
  STARTER_FEATURE_1_TEXT_1:
    '不是「完成任务换取虚拟货币」的游戏。是在 B=F(MAP) 行为模型基础上，用操作性条件反射原理，让每一次真实行动都产生可见的成长信号——XP 自动结算，等级实时更新，你不需要做任何维护。',
  STARTER_FEATURE_1_BUTTON_TEXT: '',
  STARTER_FEATURE_1_BUTTON_URL: '',

  STARTER_FEATURE_2_TITLE_1: '双币经济：让自律「有利可图」',
  STARTER_FEATURE_2_TEXT_1:
    'XP 涨等级，金币可兑换奖励。完成任务赚金币，诚实打卡得 XP，犯了坏习惯扣金币——你的自律有价格，能积累，能兑现。系统自动跑，你只管做。',
  STARTER_FEATURE_2_BUTTON_TEXT: '',
  STARTER_FEATURE_2_BUTTON_URL: '',

  STARTER_FEATURE_3_TITLE_1: '五层复盘：从模糊到清晰',
  STARTER_FEATURE_3_TEXT_1:
    '日、周、月、季、年——每一层都有自动装载的数据包，不需要你手动整理。「上次写复盘距今多少天」系统替你记着，长期自律指数趋势图让你看见真实的自己。',
  STARTER_FEATURE_3_BUTTON_TEXT: '',
  STARTER_FEATURE_3_BUTTON_URL: '',

  STARTER_FEATURE_4_TITLE_1: '知识与行动，正交设计',
  STARTER_FEATURE_4_TEXT_1:
    '同一份知识，可以同时支撑多条执行链。笔记关联专题，专题关联项目，项目推进目标——知识不再漂浮，它找到了落点。你的每一次学习，都在喂养真实的行动。',
  STARTER_FEATURE_4_BUTTON_TEXT: '',
  STARTER_FEATURE_4_BUTTON_URL: '',

  // ===== ABOUT 关于区 =====
  STARTER_ABOUT_ENABLE: true,
  STARTER_ABOUT_TITLE: '从失败里长出来的系统',
  STARTER_ABOUT_TEXT:
    '「知行合一」不是「功能清单」。<br/><br/>它来自一个真实的困境：试过 GTD、子弹笔记、番茄钟，每一个都死于「系统太重」或「做完没反馈」。<br/><br/>不是懒——是大多数系统没有解决三个根本问题：<strong>维护负担太重，成长看不见，做完了没有反馈。</strong><br/><br/>三个设计原则从此出发：<br/><br/>① <strong>单点录入，全局同步</strong>——只记一次，剩下的系统替你完成。<br/><br/>② <strong>零维护的游戏化</strong>——29 条自动化规则 + 65 条智能计算公式，你只管做，XP 自动结算。<br/><br/>③ <strong>渐进披露</strong>——新手只跑手机端就够了，系统全貌是给三个月后的你准备的。<br/><br/>你不需要一次性学会所有功能。<br/>你只需要：打开 → 记一件事 → 关掉。<br/>剩下的，它会带着你往前走。',
  STARTER_ABOUT_BUTTON_TEXT: '查看完整设计理念',
  STARTER_ABOUT_BUTTON_URL:
    'https://faize.notion.site/2b86b996aa5e82d487b781827e3af42f?source=copy_link',
  STARTER_ABOUT_IMAGE_1: '',
  STARTER_ABOUT_IMAGE_2: '',
  STARTER_ABOUT_TIPS_1: '65',
  STARTER_ABOUT_TIPS_2: '条自动化公式',
  STARTER_ABOUT_TIPS_3: '零手动维护',

  // ===== PRICING 价格区 =====
  STARTER_PRICING_ENABLE: true,
  STARTER_PRICING_TITLE: '开始你的系统',
  STARTER_PRICING_TEXT_1: '定价简单，没有套路',
  STARTER_PRICING_TEXT_2:
    '下载模板，直接开始。不需要买课，不需要加入社群，不需要联系客服。',

  STARTER_PRICING_1_TITLE: '免费体验版',
  STARTER_PRICING_1_PRICE: '免费',
  STARTER_PRICING_1_PRICE_CURRENCY: '',
  STARTER_PRICING_1_PRICE_PERIOD: '',
  STARTER_PRICING_1_HEADER: '包含内容',
  STARTER_PRICING_1_FEATURES: '基础执行系统,习惯打卡模块,每日动态站,人物志基础版',
  STARTER_PRICING_1_BUTTON_TEXT: '免费获取',
  STARTER_PRICING_1_BUTTON_URL:
    'https://faize.notion.site/4ee6b996aa5e82a18f5a01157efe93b6?source=copy_link',

  STARTER_PRICING_2_TAG: '完整版',
  STARTER_PRICING_2_TITLE: '知行合一 · 完整版',
  STARTER_PRICING_2_PRICE: '79',
  STARTER_PRICING_2_PRICE_CURRENCY: '¥',
  STARTER_PRICING_2_PRICE_PERIOD: '一次性',
  STARTER_PRICING_2_HEADER: '包含内容',
  STARTER_PRICING_2_FEATURES:
    '完整八大模块,双币经济体系,五层复盘系统,想法实验室,健康管理,使用指南,永久更新',
  STARTER_PRICING_2_BUTTON_TEXT: '即将上线',
  STARTER_PRICING_2_BUTTON_URL: '#',

  STARTER_PRICING_3_TAG: '',
  STARTER_PRICING_3_TITLE: '启动陪跑',
  STARTER_PRICING_3_PRICE: '299',
  STARTER_PRICING_3_PRICE_CURRENCY: '¥',
  STARTER_PRICING_3_PRICE_PERIOD: '一次性',
  STARTER_PRICING_3_HEADER: '包含内容',
  STARTER_PRICING_3_FEATURES:
    '完整模板包,7天启动指导（1v1）,首月复盘支持,不在模板里而在电话里的设计心法',
  STARTER_PRICING_3_BUTTON_TEXT: '即将上线',
  STARTER_PRICING_3_BUTTON_URL: '#',

  // ===== TESTIMONIALS 用户测评 =====
  STARTER_TESTIMONIALS_ENABLE: false,
  STARTER_TESTIMONIALS_TITLE: '他们在用',
  STARTER_TESTIMONIALS_TEXT_1: '真实用户在说什么',
  STARTER_TESTIMONIALS_TEXT_2: '……',
  STARTER_TESTIMONIALS_STAR_ICON: '/images/starter/testimonials/icon-star.svg',
  STARTER_TESTIMONIALS_ITEMS: [],

  // ===== FAQ 常见问题 =====
  STARTER_FAQ_ENABLE: true,
  STARTER_FAQ_TITLE: '常见问题',
  STARTER_FAQ_TEXT_1: '快速解答',
  STARTER_FAQ_TEXT_2: '几个最常被问到的问题',

  STARTER_FAQ_1_QUESTION: '「知行合一」到底是什么？',
  STARTER_FAQ_1_ANSWER:
    '一套基于 Notion 的个人操作系统。不是普通的模板，而是整合了执行系统、知识管理、游戏化激励、复盘闭环的完整体系——目的是解决「知道但做不到」的问题。',

  STARTER_FAQ_2_QUESTION: '我需要什么工具？',
  STARTER_FAQ_2_ANSWER:
    '只需要一个 Notion 账号（免费版即可）。全平台同步：电脑、手机、平板都可以用。不需要额外安装任何东西。',

  STARTER_FAQ_3_QUESTION: '游戏化会不会很幼稚？',
  STARTER_FAQ_3_ANSWER:
    '不会。「知行合一」的游戏化是行为科学层面的：XP 由 65 条公式自动结算，连击数据反映真实习惯轨迹，等级由近 30 天数据加权得出。它不是「打怪升级」——它是「让成长变成可触摸的东西」。',

  STARTER_FAQ_4_QUESTION: '买完之后会有人带我跑一遍吗？',
  STARTER_FAQ_4_ANSWER:
    '模板内含完整使用指南，下载后照着「Day 1 启动仪式」5 步走，第一个闭环 10 分钟就能跑通。如果你想更快拿到反馈，可以选择「启动陪跑」档位。',

  STARTER_FAQ_5_QUESTION: '如果中间有一天没打卡，会怎样？',
  STARTER_FAQ_5_ANSWER:
    '不会怎样。系统设计已经考虑了这个：连击断了，重新开始就是了。真正重要的不是连续天数，而是「还在用」。',

  // ===== TEAM 团队成员 =====
  STARTER_TEAM_ENABLE: false,
  STARTER_TEAM_TITLE: '',
  STARTER_TEAM_TEXT_1: '',
  STARTER_TEAM_TEXT_2: '',
  STARTER_TEAM_ITEMS: [],

  // ===== BLOG 博客区块 =====
  STARTER_BLOG_ENABLE: true,
  STARTER_BLOG_TITLE: '近期内容',
  STARTER_BLOG_COUNT: 3,
  STARTER_BLOG_TEXT_1: '来自知行实验室',
  STARTER_BLOG_TEXT_2:
    '执行架构 · AI协作心法 · 个人系统设计 · 副业探索',

  // ===== BRANDS 合作伙伴 =====
  STARTER_BRANDS_ENABLE: false,
  STARTER_BRANDS: [],

  // ===== CONTACT 联系 =====
  STARTER_CONTACT_ENABLE: true,
  STARTER_CONTACT_TITLE: '联系我们',
  STARTER_CONTACT_TEXT: '有问题或建议，欢迎留言',
  STARTER_CONTACT_LOCATION_TITLE: '',
  STARTER_CONTACT_LOCATION_TEXT: '',
  STARTER_CONTACT_EMAIL_TITLE: '邮件联系',
  STARTER_CONTACT_EMAIL_TEXT: 'hi@faiz-world.com',
  STARTER_CONTACT_MSG_EXTERNAL_URL: 'https://noteforms.com/forms/yfctc7',

  // ===== CTA 行动召唤 =====
  STARTER_CTA_ENABLE: true,
  STARTER_CTA_TITLE: '你不需要一个完美的系统',
  STARTER_CTA_TITLE_2: '你只需要一个能让你动起来的系统',
  STARTER_CTA_DESCRIPTION:
    '知行合一的设计只有一个标准：这个系统能不能让你从「想做到」变成「真的在做」。打开它，记一件事，然后关掉——这就是第一天。',
  STARTER_CTA_BUTTON: true,
  STARTER_CTA_BUTTON_URL:
    'https://faize.notion.site/4ee6b996aa5e82a18f5a01157efe93b6?source=copy_link',
  STARTER_CTA_BUTTON_TEXT: '开始使用',

  // ===== FOOTER =====
  STARTER_FOOTER_SLOGAN: '知行合一 · 不是知道了再去行动，而是在行动中成为你想成为的人。',

  STARTER_FOOTER_LINK_GROUP: [
    {
      TITLE: '关于产品',
      LINK_GROUP: [
        {
          TITLE: '了解知行合一',
          URL:
            'https://faize.notion.site/4ee6b996aa5e82a18f5a01157efe93b6?source=copy_link'
        },
        {
          TITLE: '使用指南',
          URL:
            'https://faize.notion.site/4ee6b996aa5e82a18f5a01157efe93b6?source=copy_link'
        },
        {
          TITLE: '设计理念',
          URL:
            'https://faize.notion.site/2b86b996aa5e82d487b781827e3af42f?source=copy_link'
        },
        {
          TITLE: '快速上手',
          URL:
            'https://faize.notion.site/4ee6b996aa5e82a18f5a01157efe93b6?source=copy_link'
        }
      ]
    },
    {
      TITLE: '使用支持',
      LINK_GROUP: [
        {
          TITLE: '常见问题',
          URL: '#faq'
        },
        {
          TITLE: '执行系统速查',
          URL:
            'https://faize.notion.site/4ee6b996aa5e82a18f5a01157efe93b6?source=copy_link'
        },
        {
          TITLE: '习惯打卡指南',
          URL:
            'https://faize.notion.site/4ee6b996aa5e82a18f5a01157efe93b6?source=copy_link'
        },
        {
          TITLE: '复盘体系说明',
          URL:
            'https://faize.notion.site/4ee6b996aa5e82a18f5a01157efe93b6?source=copy_link'
        }
      ]
    },
    {
      TITLE: '个人成长',
      LINK_GROUP: [
        {
          TITLE: '执行系统设计',
          URL: '/tag/执行系统'
        },
        {
          TITLE: 'AI协作心法',
          URL: '/tag/AI协作'
        },
        {
          TITLE: '知识管理',
          URL: '/tag/知识管理'
        },
        {
          TITLE: '副业探索',
          URL: '/tag/副业'
        }
      ]
    }
  ],

  STARTER_FOOTER_BLOG_LATEST_TITLE: '最新文章',
  STARTER_FOOTER_PRIVACY_POLICY_TEXT: '隐私政策',
  STARTER_FOOTER_PRIVACY_POLICY_URL: '/privacy-policy',
  STARTER_FOOTER_PRIVACY_LEGAL_NOTICE_TEXT: '',
  STARTER_FOOTER_PRIVACY_LEGAL_NOTICE_URL: '',
  STARTER_FOOTER_PRIVACY_TERMS_OF_SERVICE_TEXT: '',
  STARTER_FOOTER_PRIVACY_TERMS_OF_SERVICE_URL: '',

  // ===== 404 =====
  STARTER_404_TITLE: '这个页面不存在',
  STARTER_404_TEXT: '也许已经被归档了。去主页看看？',
  STARTER_404_BACK: '回到首页',

  STARTER_POST_REDIRECT_ENABLE: true,
  STARTER_POST_REDIRECT_URL: 'https://www.faiz-world.com',
  STARTER_NEWSLETTER: false,

  // ===== 微信支付 Paywall =====
  STARTER_PAYWALL_ENABLE: true
}
export default CONFIG
