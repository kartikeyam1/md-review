import { ref } from 'vue';
const appMode = ref('upload');
const paneMode = ref('edit');
const markdown = ref('');
const filename = ref('');
function handleFileLoaded(content, name) {
    markdown.value = content;
    filename.value = name;
    appMode.value = 'review';
}
// Expose for future use by child components
const __VLS_exposed = { appMode, paneMode, markdown, filename, handleFileLoaded };
defineExpose(__VLS_exposed);
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "app" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({});
/** @type {__VLS_StyleScopedClasses['app']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {
            ...__VLS_exposed,
        };
    },
});
; /* PartiallyEnd: #4569/main.vue */
