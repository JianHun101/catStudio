<script setup lang="ts">
/**
 * 二级导航（左侧竖排）——设置页与评估中心共用（T5 §二A：单一真相源）。
 *
 * 为什么抽组件：两处导航各写一份样式与激活判据，就是本仓反复吃过的「同一规则两处
 * 措辞」——再加一个视图就会长出第三种导航。这里把「宽 148px / 图标 + 文案一行 /
 * 激活态 --accent-soft」钉成唯一表述点。
 *
 * 为什么图标走具名 slot 而非 props：设置页三个图标是多元素 SVG（circle + path），
 * 传字符串只能经 v-html 渲染（新增注入面）。票面 OQ-2 的裁决正是「样式差异走
 * props/slot 不开分支」——slot 即该机制；不传 slot 就没有图标（评估页五 tab 原无图标）。
 *
 * 148px 是用户两轮反馈后的裁决值（原型 v6 的 188px 被嫌宽，票面 §二A）。
 */
interface SubNavItem {
  key: string
  label: string
  /** 待办角标；undefined / 0 不渲染（评估「回标」的待回标数） */
  badge?: number
}

defineProps<{
  items: SubNavItem[]
  /** 当前激活项的 key（v-model） */
  modelValue: string
  /** 导航地标名——屏幕阅读器用它区分页面里的多个 nav */
  label?: string
  /**
   * 导航顶部父标题（T6：原型 v6 `.nav-t` 形态）。
   *
   * 可选、缺省与空串都不渲染——评估中心的五 tab 本轮不传，prop 一加即零影响零 diff。
   * 为什么不写死成常驻元素：设置页的 IA 是三个平级大类、无分组语义，父标题取单标题
   * 「设置」作视觉锚；评估页没有对应诉求，写死会让它凭空多一行（票面 §三 边界）。
   */
  title?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [key: string] }>()
</script>

<template>
  <nav class="sub-nav" :aria-label="label">
    <div v-if="title" class="sub-nav-title">{{ title }}</div>
    <button
      v-for="it in items"
      :key="it.key"
      class="sub-nav-item"
      :class="{ active: it.key === modelValue }"
      :aria-current="it.key === modelValue ? 'page' : undefined"
      @click="emit('update:modelValue', it.key)"
    >
      <slot name="icon" :item="it" />
      <span class="sub-nav-label">{{ it.label }}</span>
      <span v-if="it.badge && it.badge > 0" class="sub-nav-badge">{{ it.badge }}</span>
    </button>
  </nav>
</template>

<style scoped>
.sub-nav {
  /* T5：148px——「图标 + 文案」一行放得下的下限（票面 §二A 用户裁决，原 188px） */
  width: 148px;
  flex-shrink: 0;
  padding: 18px 10px;
  border-right: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
}

/* 父标题（T6）——原型 v6 `.set-nav .nav-t` 规格：11px / 700 / letter-spacing .08em /
   padding 10px 10px 6px。那个内边距不是随手值：`.sub-nav` 自带 10px 横向内边距，
   标题再加自身的 10px ⇒ 标题文字左缘 = 容器 10 + 10 = 20px；`.sub-nav-item` 的内容盒
   左缘同理（容器 10 + item `padding: 8px 10px` 的 10px）= 20px。**两者对齐的是内容盒
   左缘**——也就是导航项**图标**的左缘；带图标时文案还要再被 `图标 14px + gap 9px`
   推到 43px 处，标题不与文案齐平（原型 v6 同形态，非缺陷）。
   任一处的横向内边距改动都会让这条对齐错开，故把关系写在这里。

   色值走 `--text-muted`：原型用的是 `--text-faint`，本仓 index.html **无此变量**，
   照抄不报错不告警、只静默失效（颜色回落继承值，与相邻元素同色 ⇒ 父标题形同消失）。
   `--text-muted` 是本仓色板里语义等价的最暗文字位。详见测试里的色板守卫。 */
.sub-nav-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--text-muted);
  padding: 10px 10px 6px;
}

.sub-nav-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 10px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
  transition: all var(--ease-out);
}

.sub-nav-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* 选中态高亮：浅色块 + 文字加深（参考图1） */
.sub-nav-item.active {
  background: var(--accent-soft);
  color: var(--accent-text);
  font-weight: 600;
}

.sub-nav-label {
  min-width: 0;
}

/* 待办角标——原评估 tab 的 .tab-badge 规格原样带入（换成竖排导航后角标要跟着走） */
.sub-nav-badge {
  margin-left: auto;
  font-size: 10px;
  font-weight: 700;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--text-on-accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
</style>
