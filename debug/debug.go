// Package debug 提供显式、默认关闭的进程级诊断出口；SDK 不读环境、不写磁盘。
package debug

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"reflect"
	"regexp"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Event 是一条结构化事件；Sequence 为进程输出序号，不替代业务序号。
type Event struct {
	Source      string  `json:"source"`
	Event       string  `json:"event"`
	RuntimeID   string  `json:"runtimeId"`
	Sequence    uint64  `json:"sequence"`
	Time        string  `json:"time"`
	MonotonicMS float64 `json:"monotonicMs"`
	Details     any     `json:"details"`
}

// Sink 由宿主提供，须并发安全、快速返回；不应回调 SDK 或写业务存储。
type Sink func(Event)

var config struct {
	sync.RWMutex
	sink Sink
}
var sequence atomic.Uint64
var started = time.Now()
var runtimeID = fmt.Sprintf("bitfs-%d", started.UnixNano())

// SetSink 显式设置调试出口；nil 关闭。CLI 在 dev 启动时设置，不逐请求切换。
func SetSink(sink Sink) { config.Lock(); config.sink = sink; config.Unlock() }
func Enabled() bool     { config.RLock(); defer config.RUnlock(); return config.sink != nil }

// Log 仅在启用时计算 details；sink panic 被隔离，不能改变交易结果。
func Log(source, event string, details func() any) {
	config.RLock()
	sink := config.sink
	config.RUnlock()
	if sink == nil {
		return
	}
	defer func() { _ = recover() }()
	var value any
	if details != nil {
		value = summary(reflect.ValueOf(details()), 0)
	}
	sink(Event{Source: source, Event: event, RuntimeID: runtimeID, Sequence: sequence.Add(1),
		Time: time.Now().UTC().Format(time.RFC3339Nano), MonotonicMS: float64(time.Since(started).Microseconds()) / 1000, Details: value})
}

// Error 保存错误链与调用栈；只接收业务错误，禁止把凭据放入错误文本。
func Error(err error) any {
	if err == nil {
		return nil
	}
	chain := []string{}
	current := err
	for i := 0; current != nil && i < 32; i++ {
		chain = append(chain, safeText(current.Error()))
		if next, ok := current.(interface{ Unwrap() error }); ok {
			current = next.Unwrap()
		} else {
			break
		}
	}
	return map[string]any{"chain": chain, "stack": string(debug.Stack())}
}

var credentialText = regexp.MustCompile(`(?i)((?:password|passwd|private[_-]?key|secret|token|api[_-]?key)\s*[=:]\s*)[^\s"',;&]+`)
var bearerText = regexp.MustCompile(`(?i)(bearer\s+)[^\s"',;]+`)

func safeText(text string) string {
	return bearerText.ReplaceAllString(credentialText.ReplaceAllString(text, "${1}[redacted]"), "${1}[redacted]")
}

func privateField(key string) bool {
	key = strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(key, "_", ""), "-", ""))
	for _, word := range []string{"password", "passwd", "privatekey", "secret", "token", "credential", "mnemonic", "wif", "authorizationheader"} {
		if strings.Contains(key, word) {
			return true
		}
	}
	return false
}
func summary(v reflect.Value, depth int) any {
	if !v.IsValid() {
		return nil
	}
	if depth > 32 {
		return "[depth-limit]"
	}
	if v.CanInterface() {
		if err, ok := v.Interface().(error); ok {
			return Error(err)
		}
	}
	switch v.Kind() {
	case reflect.String:
		return safeText(v.String())
	case reflect.Interface, reflect.Pointer:
		if v.IsNil() {
			return nil
		}
		return summary(v.Elem(), depth+1)
	case reflect.Slice, reflect.Array:
		if v.Type().Elem().Kind() == reflect.Uint8 {
			raw := make([]byte, v.Len())
			for i := range raw {
				raw[i] = byte(v.Index(i).Uint())
			}
			hash := sha256.Sum256(raw)
			return map[string]any{"byteLength": len(raw), "sha256": hex.EncodeToString(hash[:])}
		}
		result := make([]any, v.Len())
		for i := range result {
			result[i] = summary(v.Index(i), depth+1)
		}
		return result
	case reflect.Map:
		result := map[string]any{}
		iter := v.MapRange()
		for iter.Next() {
			key := fmt.Sprint(iter.Key().Interface())
			if privateField(key) {
				result[key] = "[redacted]"
			} else {
				result[key] = summary(iter.Value(), depth+1)
			}
		}
		return result
	case reflect.Struct:
		result := map[string]any{}
		for i := 0; i < v.NumField(); i++ {
			field := v.Type().Field(i)
			if field.PkgPath != "" {
				continue
			}
			if privateField(field.Name) {
				result[field.Name] = "[redacted]"
			} else {
				result[field.Name] = summary(v.Field(i), depth+1)
			}
		}
		return result
	default:
		if v.CanInterface() {
			return v.Interface()
		}
		return "[unexported]"
	}
}
