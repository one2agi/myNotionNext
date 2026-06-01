// 注: process.env.XX是Vercel的环境变量，配置方式见：https://docs.tangly1024.com/article/how-to-config-notion-next#c4768010ae7d44609b744e79e2f9959a

const BLOG = {
  TITLE: '碳基进化指北', // 网站标题（书签/浏览器标签显示）
  API_BASE_URL: process.env.API_BASE_URL || 'https://www.notion.so/api/v3', // API默认请求地址,可以配置成自己的地址例如：https://[xxxxx].notion.site/api/v3
  // Important page_id！！！Duplicate Template from  https://tanghh.notion.site/02ab3b8678004aa69e9e415905ef32a5
  NOTION_PAGE_ID:
    process.env.NOTION_PAGE_ID ||
    '02ab3b8678004aa69e9e415905ef32a5,en:7c1d570661754c8fbc568e00a01fd70e',
  THEME: process.env.NEXT_PUBLIC_THEME || 'starter', // 当前主题，在themes文件夹下可找到所有支持的主题；主题名称就是文件夹名，例如 example,fukasawa,gitbook,heo,hexo,landing,matery,medium,next,nobelium,plog,simple
  LANG: process.env.NEXT_PUBLIC_LANG || 'zh-CN', // e.g 'zh-CN','en-US'  see /lib/lang.js for more.
  SINCE: process.env.NEXT_PUBLIC_SINCE || 2021, // e.g if leave this empty, current year will be used.

  PSEUDO_STATIC: process.env.NEXT_PUBLIC_PSEUDO_STATIC || false, // 伪静态路径，开启后所有文章URL都以 .html 结尾。
  NEXT_REVALIDATE_SECOND: process.env.NEXT_PUBLIC_REVALIDATE_SECOND || 60, // 更新缓存间隔 单位(秒)；即每个页面有60秒的纯静态期、此期间无论多少次访问都不会抓取notion数据；调大该值有助于节省Vercel资源、同时提升访问速率，但也会使文章更新有延迟。
  APPEARANCE: process.env.NEXT_PUBLIC_APPEARANCE || 'light', // ['light', 'dark', 'auto'], // light 日间模式 ， dark夜间模式， auto根据时间和主题自动夜间模式
  APPEARANCE_DARK_TIME: process.env.NEXT_PUBLIC_APPEARANCE_DARK_TIME || [18, 6], // 夜间模式起至时间，false时关闭根据时间自动切换夜间模式

  AUTHOR: process.env.NEXT_PUBLIC_AUTHOR || 'faiz', // 您的昵称 例如 tangly1024
  BIO: process.env.NEXT_PUBLIC_BIO || '让那些一直知道且想做的事，开始真的发生。', // 作者简介
  LINK: process.env.NEXT_PUBLIC_LINK || 'https://faiz-world.com', // 网站地址
  KEYWORDS: process.env.NEXT_PUBLIC_KEYWORD || 'AI实战, 知行合一, 个人跃迁', // 网站关键词 英文逗号隔开
  BLOG_FAVICON: process.env.NEXT_PUBLIC_FAVICON || '/favicon.ico', // blog favicon 配置, 默认使用 /public/favicon.ico，支持在线图片，如 https://img.imesong.com/favicon.png
  BEI_AN: process.env.NEXT_PUBLIC_BEI_AN || '', // 备案号 闽ICP备XXXXXX
  BEI_AN_LINK: process.env.NEXT_PUBLIC_BEI_AN_LINK || 'https://beian.miit.gov.cn/', // 备案查询链接，如果用了萌备等备案请在这里填写
  BEI_AN_GONGAN: process.env.NEXT_PUBLIC_BEI_AN_GONGAN || '', // 公安备案号，例如 '浙公网安备3xxxxxxxx8号'

  // RSS订阅
  ENABLE_RSS: process.env.NEXT_PUBLIC_ENABLE_RSS || true, // 是否开启RSS订阅功能

  // Starter 主题文案快速自定义（未配置时会回退到 themes/starter/config.js 的默认值）
  STARTER_HERO_ENABLE: true,
  STARTER_HERO_TITLE_1: '别再往收藏夹里堆教程了。',
  STARTER_HERO_TITLE_2: '打破知行断裂，用算法和多巴胺夺回人生掌控权。',
  STARTER_HERO_BUTTON_1_TEXT: '查看实战笔记',
  STARTER_HERO_BUTTON_1_URL: '/archive',
  STARTER_HERO_BUTTON_2_TEXT: '',
  STARTER_HERO_BUTTON_2_URL: '',
  STARTER_HERO_BUTTON_2_ICON: '',

  STARTER_NAV_BUTTON_1_TEXT: '',
  STARTER_NAV_BUTTON_1_URL: '',
  STARTER_NAV_BUTTON_2_TEXT: '',
  STARTER_NAV_BUTTON_2_URL: '',

  STARTER_BRANDS_ENABLE: false,

  STARTER_FEATURE_ENABLE: true,
  STARTER_FEATURE_TITLE: '我不灌鸡汤，我只发外挂',
  STARTER_FEATURE_TEXT_1: '非IT小白用AI撸出SaaS的真实踩坑记录与系统。',
  STARTER_FEATURE_TEXT_2: '',
  STARTER_FEATURE_1_TITLE_1: '知行 OS 引擎',
  STARTER_FEATURE_1_TEXT_1: '将吃灰的笔记无缝转化为带XP和金币的执行流。',
  STARTER_FEATURE_1_BUTTON_TEXT: '了解系统',
  STARTER_FEATURE_1_BUTTON_URL: '/archive',
  STARTER_FEATURE_2_TITLE_1: 'AI 野生实战',
  STARTER_FEATURE_2_TEXT_1: '只分享能立刻落地的低门槛 AI 变现与开发玩法。',
  STARTER_FEATURE_2_BUTTON_TEXT: '看实操录',
  STARTER_FEATURE_2_BUTTON_URL: '/archive',
  STARTER_FEATURE_3_TITLE_1: '',
  STARTER_FEATURE_3_TEXT_1: '',
  STARTER_FEATURE_3_BUTTON_TEXT: '',
  STARTER_FEATURE_3_BUTTON_URL: '',
  STARTER_FEATURE_4_TITLE_1: '',
  STARTER_FEATURE_4_TEXT_1: '',
  STARTER_FEATURE_4_BUTTON_TEXT: '',
  STARTER_FEATURE_4_BUTTON_URL: '/archive',

  STARTER_ABOUT_ENABLE: true,
  STARTER_ABOUT_TITLE: '我是谁？',
  STARTER_ABOUT_TEXT:
    '经管学院出生，非IT背景。<br /><br />2025年半年用 Claude Code × (PRP+Spec) 开发范式，独立全栈开发 SaaS 系统。<br /><br />认知不是用来存的，是用来燃的。我只做一件事：把知道的，立刻变成做过的。',
  STARTER_ABOUT_BUTTON_TEXT: '我的文章',
  STARTER_ABOUT_BUTTON_URL: '/archive',

  STARTER_PRICING_ENABLE: false,
  STARTER_TESTIMONIALS_ENABLE: false,
  STARTER_FAQ_ENABLE: false,
  STARTER_TEAM_ENABLE: false,

  STARTER_BLOG_ENABLE: true,
  STARTER_BLOG_TITLE: '文章',
  STARTER_BLOG_COUNT: 6,
  STARTER_BLOG_TEXT_1: '最近更新',
  STARTER_BLOG_TEXT_2: '从这里开始阅读。',

  STARTER_CONTACT_ENABLE: false,

  STARTER_CTA_ENABLE: false,

  STARTER_FOOTER_SLOGAN: '翻山的人，最懂山路有多难走。',
  STARTER_FOOTER_LINK_GROUP: [
    {
      TITLE: '导航',
      LINK_GROUP: [
        { TITLE: '首页', URL: '/#home' },
        { TITLE: '文章归档', URL: '/archive' }
      ]
    },
    {
      TITLE: '分类',
      LINK_GROUP: [
        { TITLE: '分类', URL: '/category' },
        { TITLE: '标签', URL: '/tag' }
      ]
    },
    {
      TITLE: '更多',
      LINK_GROUP: [{ TITLE: 'RSS', URL: '/feed' }]
    }
  ],

  // 其它复杂配置
  // 原配置文件过长，且并非所有人都会用到，故此将配置拆分到/conf/目录下, 按需找到对应文件并修改即可
  ...require('./conf/comment.config'), // 评论插件
  ...require('./conf/contact.config'), // 作者联系方式配置
  ...require('./conf/post.config'), // 文章与列表配置
  ...require('./conf/analytics.config'), // 站点访问统计
  ...require('./conf/image.config'), // 网站图片相关配置
  ...require('./conf/font.config'), // 网站字体
  ...require('./conf/right-click-menu'), // 自定义右键菜单相关配置
  ...require('./conf/code.config'), // 网站代码块样式
  ...require('./conf/animation.config'), // 动效美化效果
  ...require('./conf/widget.config'), // 悬浮在网页上的挂件，聊天客服、宠物挂件、音乐播放器等
  ...require('./conf/ad.config'), // 广告营收插件
  ...require('./conf/plugin.config'), // 其他第三方插件 algolia全文索引
  ...require('./conf/performance.config'), // 性能优化配置

  // 高级用法
  ...require('./conf/layout-map.config'), // 路由与布局映射自定义，例如自定义特定路由的页面布局
  ...require('./conf/notion.config'), // 读取notion数据库相关的扩展配置，例如自定义表头
  ...require('./conf/dev.config'), // 开发、调试时需要关注的配置

  // 自定义外部脚本，外部样式
  CUSTOM_EXTERNAL_JS: [''], // e.g. ['http://xx.com/script.js','http://xx.com/script.js']
  CUSTOM_EXTERNAL_CSS: [''], // e.g. ['http://xx.com/style.css','http://xx.com/style.css']

  // 自定义菜单
  CUSTOM_MENU: process.env.NEXT_PUBLIC_CUSTOM_MENU || true, // 支持Menu类型的菜单，替代了3.12版本前的Page类型

  // 文章列表相关设置
  CAN_COPY: process.env.NEXT_PUBLIC_CAN_COPY || true, // 是否允许复制页面内容 默认允许，如果设置为false、则全栈禁止复制内容。

  // 侧栏布局 是否反转(左变右,右变左) 已支持主题: hexo next medium fukasawa example
  LAYOUT_SIDEBAR_REVERSE:
    process.env.NEXT_PUBLIC_LAYOUT_SIDEBAR_REVERSE || false,

  // 欢迎语打字效果,Hexo,Matery主题支持, 英文逗号隔开多个欢迎语。
  GREETING_WORDS:
    process.env.NEXT_PUBLIC_GREETING_WORDS ||
    '欢迎来到我的博客,记录与分享,保持好奇与持续输出',

  // uuid重定向至 slug
  UUID_REDIRECT: process.env.UUID_REDIRECT || false,

  // ===== 微信支付 Paywall（MVP 接入） =====
  // 临时关掉 starter 主题的文章页整页重定向（默认是 true，会把所有文章 302 到
  // https://www.faiz-world.com，根本看不到挂载的 PaywallButton）。
  // 跑通支付链路后视情况决定是否恢复。
  STARTER_POST_REDIRECT_ENABLE: false
}

module.exports = BLOG
