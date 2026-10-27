<script setup>
import { ref } from 'vue'

const notice = ref('')

function runPrimaryAction() {
  notice.value = '主操作已触发；请按 PRD 替换为真实场景反馈。'
}
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar" aria-label="原型导航">
      <strong>产品原型</strong>
      <span>导航占位</span>
    </aside>

    <main class="workspace">
      <header class="page-header">
        <div>
          <p class="eyebrow">VUE INTERACTIVE PROTOTYPE</p>
          <h1>替换为需求主场景</h1>
        </div>
        <button class="primary-button" type="button" @click="runPrimaryAction">
          主操作
        </button>
      </header>

      <section class="panel">
        <h2>页面内容区</h2>
        <p>根据已确认 PRD 和 design/context.md 替换本区，不要把示例样式当成项目规范。</p>
        <p v-if="notice" class="notice" role="status">{{ notice }}</p>
      </section>
    </main>
  </div>
</template>
