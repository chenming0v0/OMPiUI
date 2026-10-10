package mobile

import (
	"errors"
	"strings"
	"testing"

	"tailscale.com/net/netmon"
)

func TestStartReturnsNativePanicAsError(t *testing.T) {
	t.Setenv("TS_LOGS_DIR", "")
	// 模拟平台接口回调抛出 panic，验证真实启动路径不会让 JNI 调用终止进程。
	netmon.RegisterInterfaceGetter(func() ([]netmon.Interface, error) {
		panic("Android interface callback failed")
	})
	t.Cleanup(func() { netmon.RegisterInterfaceGetter(nil) })
	if err := Start(t.TempDir(), "ompiui-test"); err == nil ||
		!strings.Contains(err.Error(), "Android interface callback failed") {
		t.Fatalf("start did not return the native failure: %v", err)
	}
	if node != nil {
		t.Fatal("failed startup published a running node")
	}
	if err := Login(); err == nil {
		t.Fatal("failed startup unexpectedly allowed login")
	}
}

func TestNativeErrorPreservesOrdinaryFailure(t *testing.T) {
	want := errors.New("authorization failed")
	call := func() (err error) {
		defer recoverNativeError("login", &err)
		return want
	}
	if err := call(); err != want {
		t.Fatalf("normal errors changed: %v", err)
	}
}
