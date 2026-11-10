CP.cron = CP.cron || {};
CP.cron.bits = (function () {
  "use strict";

  function make(min, max) {
    return { min: min, max: max, data: new Uint8Array(max - min + 1) };
  }

  function has(bits, value) {
    return value >= bits.min && value <= bits.max && bits.data[value - bits.min] === 1;
  }

  function set(bits, value) {
    if (value >= bits.min && value <= bits.max) bits.data[value - bits.min] = 1;
  }

  function fill(bits, from, to, step) {
    const stride = step > 0 ? step : 1;
    for (let value = from; value <= to; value += stride) set(bits, value);
  }

  function count(bits) {
    let total = 0;
    for (let index = 0; index < bits.data.length; index += 1) total += bits.data[index];
    return total;
  }

  function toArray(bits) {
    const values = [];
    for (let index = 0; index < bits.data.length; index += 1) {
      if (bits.data[index]) values.push(index + bits.min);
    }
    return values;
  }

  function union(a, b) {
    const result = make(Math.min(a.min, b.min), Math.max(a.max, b.max));
    for (const value of toArray(a)) set(result, value);
    for (const value of toArray(b)) set(result, value);
    return result;
  }

  function intersect(a, b) {
    const result = make(Math.min(a.min, b.min), Math.max(a.max, b.max));
    for (const value of toArray(a)) if (has(b, value)) set(result, value);
    return result;
  }

  function fromField(fieldAst, fieldSpec) {
    const bits = make(fieldSpec.min, fieldSpec.max);
    const specials = [];
    let wildcard = false;
    let question = false;
    if (!fieldAst) return { bits: bits, specials: specials, wildcard: true, question: false, concrete: false };
    if (fieldAst.kind === "wildcard") wildcard = true;
    if (fieldAst.kind === "question") question = true;
    for (const item of fieldAst.items || []) {
      const type = item.type;
      if (type === "wildcard") {
        wildcard = true;
        fill(bits, fieldSpec.min, fieldSpec.max, 1);
      } else if (type === "value" || type === "names") {
        set(bits, item.canonical !== undefined ? item.canonical : item.value);
      } else if (type === "range" || type === "step") {
        const from = item.canonicalFrom !== undefined ? item.canonicalFrom : item.from;
        const to = item.canonicalTo !== undefined ? item.canonicalTo : item.to;
        fill(bits, from, to, item.step || 1);
        if (item.base === "*" && (!item.step || item.step === 1)) wildcard = true;
      } else if (type === "special") {
        specials.push(item);
      }
    }
    const concrete = !wildcard && !question && (count(bits) > 0 || specials.length > 0);
    return { bits: bits, specials: specials, wildcard: wildcard, question: question, concrete: concrete };
  }

  return {
    make: make, has: has, set: set, fill: fill, count: count,
    toArray: toArray, union: union, intersect: intersect, fromField: fromField
  };
})();
