package r2link

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sync"

	"github.com/coder/websocket"
)

// Frame 是一条消息：JSON 头与二进制尾部。WebSocket 的一条 Binary Message 就是一条消息，
// 消息体为 uint32LE(JSON 字节数) + UTF-8 JSON + 尾部。
type Frame struct {
	Type   string
	Header json.RawMessage
	Tail   []byte
}

// Decode 把 JSON 头解到 v。
func (f Frame) Decode(v any) error {
	return json.Unmarshal(f.Header, v)
}

// EncodeFrame 写出一条消息的字节。
func EncodeFrame(header any, tail []byte) ([]byte, error) {
	text, err := json.Marshal(header)
	if err != nil {
		return nil, err
	}
	data := make([]byte, 4, 4+len(text)+len(tail))
	binary.LittleEndian.PutUint32(data, uint32(len(text)))
	data = append(data, text...)
	return append(data, tail...), nil
}

// DecodeFrame 拆分 JSON 头与尾部，并读出 type。
func DecodeFrame(data []byte) (Frame, error) {
	if len(data) < 4 {
		return Frame{}, fmt.Errorf("R2Link 消息缺少头长度")
	}
	size := binary.LittleEndian.Uint32(data)
	if uint64(size) > uint64(len(data)-4) {
		return Frame{}, fmt.Errorf("R2Link JSON 长度超出消息")
	}
	frame := Frame{Header: data[4 : 4+size], Tail: data[4+size:]}
	var kind struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(frame.Header, &kind); err != nil {
		return Frame{}, err
	}
	if kind.Type == "" {
		return Frame{}, fmt.Errorf("R2Link 消息缺少 type")
	}
	frame.Type = kind.Type
	return frame, nil
}

// Conn 是一条 R2Link 连接。Send 可以在多个协程里调用；Receive 同一时间只能有一个调用者。
type Conn struct {
	ws    *websocket.Conn
	write sync.Mutex
}

// NewConn 包装已建立的 WebSocket，limit 限制单条收到的消息大小。
func NewConn(ws *websocket.Conn, limit int64) *Conn {
	ws.SetReadLimit(limit)
	return &Conn{ws: ws}
}

// Accept 在 HTTP 请求上接受浏览器的连接。options 为 nil 时接受任何页面来源，
// 适合只提供只读世界数据、由别的页面连接的数据源；传入 &websocket.AcceptOptions{} 只接受同源页面。
// 浏览器发来的消息很小，单条限制 4 MiB。
func Accept(w http.ResponseWriter, r *http.Request, options *websocket.AcceptOptions) (*Conn, error) {
	if options == nil {
		options = &websocket.AcceptOptions{InsecureSkipVerify: true}
	}
	ws, err := websocket.Accept(w, r, options)
	if err != nil {
		return nil, err
	}
	return NewConn(ws, 4<<20), nil
}

// Dial 以浏览器的身份连接 ws:// 或 wss:// 地址，供 Go 客户端与测试使用；区域消息较大，单条限制 256 MiB。
func Dial(ctx context.Context, address string) (*Conn, error) {
	parsed, err := url.Parse(address)
	if err != nil {
		return nil, err
	}
	if parsed.Scheme != "ws" && parsed.Scheme != "wss" {
		return nil, fmt.Errorf("连接地址使用 ws:// 或 wss://")
	}
	ws, _, err := websocket.Dial(ctx, address, nil)
	if err != nil {
		return nil, err
	}
	return NewConn(ws, 256<<20), nil
}

// Send 把 JSON 头和尾部写成一条消息。
func (c *Conn) Send(ctx context.Context, header any, tail []byte) error {
	data, err := EncodeFrame(header, tail)
	if err != nil {
		return err
	}
	c.write.Lock()
	defer c.write.Unlock()
	return c.ws.Write(ctx, websocket.MessageBinary, data)
}

// Receive 读取一条消息。
func (c *Conn) Receive(ctx context.Context) (Frame, error) {
	kind, data, err := c.ws.Read(ctx)
	if err != nil {
		return Frame{}, err
	}
	if kind != websocket.MessageBinary {
		return Frame{}, fmt.Errorf("R2Link 使用二进制 WebSocket 消息")
	}
	return DecodeFrame(data)
}

// Close 正常关闭连接，reason 会交给对端。
func (c *Conn) Close(reason string) error {
	return c.ws.Close(websocket.StatusNormalClosure, reason)
}

// CloseNow 立即关闭连接，唤醒正在读取的协程。
func (c *Conn) CloseNow() error {
	return c.ws.CloseNow()
}
