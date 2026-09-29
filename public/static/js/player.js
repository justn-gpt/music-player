//音乐播放器的类 单例模式
class Player {
    constructor() { 
        if (Player.instance) return Player.instance;
        return this.getInstance(...arguments);
    }

    //构建实例
    getInstance() {
        let instance = new PlayerCreator(...arguments);
        // instance.__proto__=Player.prototype;
        // instance.constructor=Player;
        //把构建好的实例挂在Player类上
        Player.instance = instance;
        return instance;
    }
}

//歌曲信息
class Musics {
    constructor() {
        this.songs = [];
        this.loadMusicList();
    }

    loadMusicList() {
        $.ajax({
            url: '/api/music/list',  // 获取音乐列表的接口地址
            method: 'GET',
            async: false,
            success: (response) => {
                const bgp = ["a.jpg", "b.jpg" , "c.jpg", "d.jpg", "e.jpg"];
                if (response && response.data) {
                    response.data.forEach(item => {
                        const fileName = item.filename;
                        const nameWithoutExt = fileName.replace(/\.[^/.]+$/, "");
                        let title, singer;
                        
                        // 处理带有 "-" 的文件名
                        if (nameWithoutExt.includes('-')) {
                            const parts = nameWithoutExt.split('-');
                            title = parts[0].trim();
                            singer = parts[1].trim();
                        } else {
                            title = nameWithoutExt;
                            singer = "未知";
                        }

                        this.songs.push({
                            fileName: fileName,
                            title: title,
                            singer: singer,
                            songUrl: item.url,
                            imageUrl: '/static/music_data/images/' + bgp[Math.floor(Math.random() * bgp.length)]
                        });
                    });
                }
            },
            error: (xhr, status, error) => {
                console.error('获取音乐列表失败:', error);
                alert('获取音乐列表失败，请检查网络连接');
            }
        });
    }
    //根据索引获取歌曲的方法
    getSongByNum(index) {
        return this.songs[index];
    }
}

//真正的构建播放器的类
class PlayerCreator {
    constructor() {
        this.audio = document.querySelector('.music-player__audio') // Audio dom元素, 因为很多api都是需要原生audio调用的，所以不用jq获取
        // this.audio.muted = true; // 控制静音
        this.audio.volume = 0.8;

        //工具
        this.util = new Util();
        this.musics = new Musics(); //歌曲信息

        this.song_index = 0; // 当前播放的歌曲索引
        this.loop_mode = 0; // 1 2
        // 下方歌曲列表容器
        this.song_list = $('.music__list_content');
        this.song_find = $('.find_song');
        this.search_button = $('.bar7 button')

        this.render_doms = { //切换歌曲时需要渲染的dom组
            title: $('.music__info--title'),
            singer: $('.music__info--singer'),
            image: $('.music-player__image img'),
            blur: $('.music-player__blur')
        }
        this.ban_dom = { //禁音时需要渲染的dom组
            control__btn: $('.control__volume--icon')
        }

        // 时间显示容器
        this.render_time = {
            now: $('.nowTime'),
            total: $('.totalTime')
        }

        // 唱片
        this.disc = {
            image: $('.music-player__image'),
            pointer: $('.music-player__pointer')
        };
        //播放器初始化
        this.init();
    }
    //初始化函数
    init() {
        this.renderSongList();
        this.renderSongStyle();
        this.bindEventListener();
    }
    //生成播放列表
    // 修改 renderSongList 方法
    renderSongList() {
        this.song_list = $('.music__list_content');
        let _str = '';
        this.musics.songs.forEach((song, i) => {
            const isPlaying = i === this.song_index ? ' class="music__list__item play"' : ' class="music__list__item"';
            _str += `<li${isPlaying} data-index="${i}">${song.title} - ${song.singer} <a href="${song.songUrl}" style="float:right;padding-right:12px">下载</a></li>`;
        });
        this.song_list.html(_str);

        // 重新绑定点击事件
        this.song_list.off('click').on('click', 'li', (e) => {
            if ($(e.target).is('a')) return; // 如果点击的是下载链接，不执行播放
            const index = parseInt($(e.target).closest('li').data('index'));
            if (!isNaN(index)) {
                this.changeSong(index);
                this.audio.play();
                // 更新播放按钮状态
                this.$play.$el.find('i').removeClass('icon-play').addClass('icon-pause');
                this.disc.image.addClass('play');
                this.disc.pointer.addClass('play');
            }
        });
    }

    //根据歌曲去渲染视图
    renderSongStyle() {
        let {
            title,
            singer,
            songUrl,
            imageUrl
        } = this.musics.getSongByNum(this.song_index);
        this.audio.src = songUrl;
        this.render_doms.title.html(title);
        this.render_doms.singer.html(singer);
        document.title = title+" - "+singer;
        this.render_doms.image.prop('src', imageUrl);
        this.render_doms.blur.css('background-image', 'url("' + imageUrl + '")');

        //切换列表中的item的类名 play
        this.song_list.find('.music__list__item').eq(this.song_index).addClass('play').siblings().removeClass('play');
    }
    //绑定各种事件
    bindEventListener() {
        // 搜索功能
        this.song_find.on('keyup', (e) => {
            const searchText = $.trim(this.song_find.val().toString());
            
            // 按下回车键时进行搜索并播放
            if (e.keyCode === 13) {
                this.searchAndPlaySong(searchText);
                return;
            }

            // 实时过滤显示匹配的歌曲
            this.filterSongList(searchText);
        });

        // 搜索框失去焦点时恢复完整列表
        this.song_find.on('blur', () => {
            setTimeout(() => {
                this.renderSongList();
                this.song_find.val('');
            }, 200);
        });

        // 搜索按钮点击事件
        this.search_button.on('click', () => {
            const searchText = $.trim(this.song_find.val().toString());
            this.searchAndPlaySong(searchText);
        });

        // 点击搜结果外任意元素将隐藏搜索结果
        $(document).click(function () {
            $(".search_list").slideUp();
            $(".download").fadeOut();
        });
        $(".search_list").click(function (event) {
            event.stopPropagation();
        });

        //播放按钮
        this.$play = new Btns('.player-control__btn--play', {
            click: this.handlePlayAndPause.bind(this)
        });
        //上一首
        this.$prev = new Btns('.player-control__btn--prev', {
            click: this.changeSong.bind(this, 'prev')
        });
        //下一首
        this.$next = new Btns('.player-control__btn--next', {
            click: this.changeSong.bind(this, 'next')
        });
        //循环模式
        this.$mode = new Btns('.player-control__btn--mode', {
            click: this.changePlayMode.bind(this)
        });
        //禁音
        this.$ban = new Btns('.control__volume--icon', {
            click: this.banNotes.bind(this)
        });

        // 管理按钮
        this.$management = new Btns('.management-btn', {
            click: this.showManagementModal.bind(this)
        });

        // 关闭按钮
        this.$closeModal = new Btns('.close-btn', {
            click: this.hideManagementModal.bind(this)
        });

        // 添加歌曲按钮
        this.$addSong = new Btns('#add-song', {
            click: this.handleAddSong.bind(this)
        });

        // 删除歌曲按钮
        this.$deleteSong = new Btns('#delete-song', {
            click: this.handleDeleteSong.bind(this)
        });

        // 上传本地文件按钮
        this.$uploadSong = new Btns('#upload-song', {
            click: this.handleUploadSong.bind(this)
        });

        // 点击遮罩层关闭模态框
        $('.modal-overlay').click(this.hideManagementModal.bind(this));

        //音量控制 audio标签音量 vlouem 属性控制0-1
        this.volume = new Progress('.control__volume--progress', {
            min: 0,
            max: 1,
            value: this.audio.volume,
            handler: (value) => { //更改进度时
                this.audio.volume = value;
            }
        });

        // 初始化音量进度条显示
        this.volume.setValue(this.audio.volume);


        //歌曲进度 this.audio.duration

        //可以播放的时候触发（歌曲的基本信息都已经获取到了）
        this.audio.oncanplay = () => {
            // 先更新总时长
            this.render_time.total.html(this.util.formatTime(this.audio.duration));
            
            // 确保进度条只初始化一次
            if (!this.progress) {
                this.progress = new Progress('.player__song--progress', {
                    min: 0,
                    max: this.audio.duration,
                    value: 0,
                    handler: (value) => {
                        this.audio.currentTime = value;
                    }
                });
            } else {
                // 如果进度条已存在，只更新最大值和当前值
                this.progress.max = this.audio.duration;
                this.progress.setValue(this.audio.currentTime);
            }
        }

        //会在播放的时候持续触发
        this.audio.ontimeupdate = () => {
            // 确保进度条和时间都正确更新
            if (this.progress && !isNaN(this.audio.currentTime)) {
                this.progress.setValue(this.audio.currentTime);
                this.render_time.now.html(this.util.formatTime(this.audio.currentTime));
            }
        }

        //当歌曲播放完成的时候
        this.audio.onended = () => {
            this.changeSong('next');
            //播放完，换歌后，重新播放
            this.audio.play();
        }

    }

    // 显示管理模态框
    showManagementModal() {
        $('#song-url').val('');
        $('#song-name').val('');
        $('#admin-password').val('');
        $('#delete-song-name').val('');
        
        $('.modal-overlay').fadeIn();
        $('.management-modal').fadeIn();
    }

    // 隐藏管理模态框
    hideManagementModal() {
        $('#song-url').val('');
        $('#song-name').val('');
        $('#admin-password').val('');
        $('#delete-song-name').val('');
        
        $('.modal-overlay').fadeOut();
        $('.management-modal').fadeOut();
    }

    // 处理添加歌曲
    handleAddSong() {
        const url = $('#song-url').val().trim();
        const name = $('#song-name').val().trim();
        const password = $('#admin-password').val().trim();

        if (!url) {
            alert('请输入音乐URL');
            return;
        }

        if (!password) {
            alert('请输入管理密码');
            return;
        }
    
        // 保存当前播放状态
        const wasPlaying = !this.audio.paused;
        const currentTime = this.audio.currentTime;
        const currentSongIndex = this.song_index;
    
        $.get('/api/download', { url, name, password })
            .done(response => {
                alert(response.success ? '歌曲已添加到下载队列' : response.error || '添加失败');
                if (response.success) {
                    // 刷新音乐列表但不重置播放状态
                    this.musics = new Musics();
                    setTimeout(() => {
                        // 恢复之前的播放状态
                        this.song_index = currentSongIndex;
                        this.renderSongList();
                        this.renderSongStyle();
                        
                        if (wasPlaying) {
                            this.audio.currentTime = currentTime;
                            this.audio.play();
                            this.$play.$el.find('i').removeClass('icon-play').addClass('icon-pause');
                            this.disc.image.addClass('play');
                            this.disc.pointer.addClass('play');
                        }
                        
                        this.hideManagementModal();
                    }, 1000);
                }
            })
            .fail(error => {
                alert('添加失败: ' + (error.responseJSON?.error || error.statusText));
            });
    }

    // 处理上传本地文件（浏览器直传R2，不经过Node服务器中转）
    handleUploadSong() {
        const fileInput = document.getElementById('local-file');
        const file = fileInput.files[0];
        const password = $('#admin-password').val().trim();

        if (!file) {
            alert('请先选择要上传的文件');
            return;
        }

        if (!password) {
            alert('请输入管理密码');
            return;
        }

        const wasPlaying = !this.audio.paused;
        const currentTime = this.audio.currentTime;
        const currentSongIndex = this.song_index;

        // 第一步：问服务器要一个R2的预签名上传链接
        $.get('/api/upload-url', { filename: file.name, password })
            .done(response => {
                if (!response.success) {
                    alert(response.error || '获取上传链接失败');
                    return;
                }

                // 第二步：浏览器直接把文件PUT给R2，不经过Armbian
                fetch(response.uploadUrl, {
                    method: 'PUT',
                    body: file,
                    headers: { 'Content-Type': file.type || 'application/octet-stream' }
                })
                .then(uploadRes => {
                    if (!uploadRes.ok) {
                        throw new Error('R2直传失败，状态码: ' + uploadRes.status);
                    }
                    alert('上传成功');
                    fileInput.value = '';
                    this.musics = new Musics();
                    setTimeout(() => {
                        this.song_index = currentSongIndex;
                        this.renderSongList();
                        this.renderSongStyle();
                        if (wasPlaying) {
                            this.audio.currentTime = currentTime;
                            this.audio.play();
                        }
                        this.hideManagementModal();
                    }, 1000);
                })
                .catch(err => {
                    alert('上传失败: ' + err.message);
                });
            })
            .fail(error => {
                alert('获取上传链接失败: ' + (error.responseJSON?.error || error.statusText));
            });
    }

    // 处理删除歌曲
    handleDeleteSong() {
        const password = $('#admin-password').val().trim();
        const name = $('#delete-song-name').val().trim();
        
        if (!password) {
            alert('请输入管理密码');
            return;
        }

        const confirmMsg = name ? `确定要删除歌曲 "${name}" 吗?` : '确定要删除所有歌曲吗?';
        if (!confirm(confirmMsg)) return;

        // 将参数作为请求体发送，提高安全性
        const requestData = {
            password: password,
            names: name || undefined,
            all: name ? undefined : 'true'
        };

        // 使用 AJAX 请求发送数据
        $.ajax({
            url: '/api/delete/music',
            method: 'POST',
            data: JSON.stringify(requestData),
            contentType: 'application/json',
            success: (response) => {
                alert(response.success ? `已删除 ${response.deletedFiles.length} 首歌曲` : response.error || '删除失败');
                if (response.success) {
                    // 刷新音乐列表
                    this.musics = new Musics();
                    setTimeout(() => {
                        this.renderSongList();
                        this.renderSongStyle();
                        if (this.song_index >= this.musics.songs.length) {
                            this.song_index = 0;
                        }
                    }, 1000);
                    this.hideManagementModal();
                }
            },
            error: (xhr) => {
                alert('删除失败: ' + (xhr.responseJSON?.error || xhr.statusText));
            }
        });
    }

    //播放暂停控制
    handlePlayAndPause() {
        let _o_i = this.$play.$el.find('i');
        //this.audio.pauseed值为true 说明目前是不播放
        if (this.audio.paused) { //现在是暂停的 要播放
            this.audio.play();
            _o_i.removeClass('icon-play').addClass('icon-pause');
            this.disc.image.addClass('play');
            this.disc.pointer.addClass('play')
        } else {
            this.audio.pause();
            _o_i.addClass('icon-play').removeClass('icon-pause');
            this.disc.image.removeClass('play');
            this.disc.pointer.removeClass('play');
        }
    }

    //更改循环模式
    changePlayMode() {
        this.loop_mode++;
        if (this.loop_mode > 2) this.loop_mode = 0;
        this.renderPlayMode();
    }
    //更改按钮样式
    renderPlayMode() {
        let _classess = ['loop', 'random', 'single'];
        let _o_i = this.$mode.$el.find('i');
        //prop 改一些标签的自有属性 attr改一些标签的自定义属性
        _o_i.prop('class', 'iconfont icon-' + _classess[this.loop_mode])
    }

    //更改歌曲索引
    changeSongIndex(type) {
        if (typeof type === 'number') {
            this.song_index = type;
        } else {
            if (this.loop_mode === 0) {
                //列表循环
                this.song_index += type === 'next' ? 1 : -1;
                if (this.song_index > this.musics.songs.length - 1) this.song_index = 0;
                if (this.song_index < 0) this.song_index = this.musics.songs.length - 1;
            } else if (this.loop_mode === 1) {
                //随机播放
                let _length = this.musics.songs.length;
                let _random = Math.floor(Math.random() * _length);
                for (let i = 0; i < 10000; i++) { //随机的数为本身则继续随机
                    if (this.song_index == _random) {
                        _random = Math.floor(Math.random() * _length);
                    } else {
                        this.song_index = _random;
                        break;
                    }
                }
            } else if (this.loop_mode === 2) {
                this.song_index = this.song_index;
            }
        }
    }
    //歌曲时长
    songTime() {
        let totalMinute = parseInt(this.audio.duration / 60) < 10 ? "0" + parseInt(this.audio.duration / 60) : parseInt(this.audio.duration / 60);
        let totalSecond = parseInt(this.audio.duration % 60) < 10 ? "0" + parseInt(this.audio.duration % 60) : parseInt(this.audio.duration % 60);
        $('.totalTime').text(totalMinute + ':' + totalSecond);
    }
    //切换歌曲
    changeSong(type) {
        //更改索引
        this.changeSongIndex(type);
        //记录切歌前的状态
        let _is_pause = this.audio.paused;
        //切歌后更改视图显示
        this.renderSongStyle();
        
        // 重置进度条
        if (this.progress) {
            this.progress.$back.width(0);
            this.progress.$pointer.css('left', 0);
        }

        // 监听音频加载完成事件
        this.audio.onloadedmetadata = () => {
            // 更新总时长
            this.render_time.total.html(this.util.formatTime(this.audio.duration));
            
            // 初始化进度条
            if (!this.progress) {
                this.progress = new Progress('.player__song--progress', {
                    min: 0,
                    max: this.audio.duration,
                    value: 0,
                    handler: (value) => {
                        this.audio.currentTime = value;
                    }
                });
            } else {
                this.progress.max = this.audio.duration;
                this.progress.setValue(0);
            }
        }

        //如果切歌前是在播放，就继续播放
        if (!_is_pause) this.audio.play();
    }
    //禁音
    banNotes() {
        let _o_i = this.$ban.$el.find("i");
        if (this.audio.muted == true) {
            this.audio.muted = false;
            _o_i.removeClass('icon-muted').addClass('icon-volume');
        } else {
            this.audio.muted = true;
            _o_i.removeClass('icon-volume').addClass('icon-muted');
        }
    }

    // 添加搜索相关方法
    searchAndPlaySong(searchText) {
        if (!searchText) return;
        
        const foundIndex = this.musics.songs.findIndex(song => 
            (song.title + ' - ' + song.singer).toLowerCase().includes(searchText.toLowerCase())
        );
        
        if (foundIndex !== -1) {
            this.changeSong(foundIndex);
            this.audio.play();
            // 更新播放按钮状态
            this.$play.$el.find('i').removeClass('icon-play').addClass('icon-pause');
            this.disc.image.addClass('play');
            this.disc.pointer.addClass('play');

            // 3秒后自动返回列表
            setTimeout(() => {
                this.renderSongList();
                this.song_find.val('');
            }, 3000);
        }
    }

    filterSongList(searchText) {
        if (!searchText) {
            this.renderSongList();
            return;
        }

        let _str = '';
        this.musics.songs.forEach((song, i) => {
            if ((song.title + ' - ' + song.singer).toLowerCase().includes(searchText.toLowerCase())) {
                // 为每个搜索结果项添加 data-index 属性，存储原始索引
                _str += `<li class="music__list__item" data-index="${i}">${song.title} - ${song.singer} <a href="${song.songUrl}" style="float:right;padding-right:12px">下载</a></li>`;
            }
        });
        this.song_list.html(_str);

        // 重新绑定点击事件
        this.song_list.off('click').on('click', 'li', (e) => {
            if ($(e.target).is('a')) return; // 如果点击的是下载链接，不执行播放
            const index = parseInt($(e.target).closest('li').data('index'));
            if (!isNaN(index)) {
                this.changeSong(index);
                this.audio.play();
                // 更新播放按钮状态
                this.$play.$el.find('i').removeClass('icon-play').addClass('icon-pause');
                this.disc.image.addClass('play');
                this.disc.pointer.addClass('play');
            }
        });
    }
}

//进度条
class Progress {
    constructor(selector, options) {
        $.extend(this, options);
        this.$el = $(selector);
        this.width = this.$el.width();
        this.init();
    }

    //进度条初始化
    init() {
        this.renderBackAndPointer();
        this.bindEvents();
        this.drag();
        this.value = this.value || 0;
    }

    //为进度条渲染back和pointer
    renderBackAndPointer() {
        this.$back = $('<div class="back">');
        this.$pointer = $('<div class="pointer">');
        this.$el.append(this.$back);
        this.$el.append(this.$pointer);
    }

    setValue(value) {
        if (!this.max || isNaN(value)) return;
        this.value = Math.min(Math.max(value, this.min), this.max);
        let _distance = this.width * (this.value - this.min) / (this.max - this.min);
        this.changeDOMStyle(_distance);
    }

    //更改pointer和back
    changeDOMStyle(distance) {
        if (isNaN(distance)) return;
        distance = Math.max(0, Math.min(distance, this.width));
        this.$back.width(distance);
        this.$pointer.css('left', Math.max(0, distance - 7) + 'px');
    }

    bindEvents() {
        this.$el.click((e) => {
            let _x = e.offsetX;
            let _ratio = _x / this.width;
            let _value = _ratio * (this.max - this.min) + this.min;
            this.setValue(_value);
            this.handler(_value);
        });
    }

    drag() {
        let ele = this.$pointer;
        let father = this.$el;
        let flag = false;
        
        ele.mousedown((e) => {
            flag = true;
            let mousePos = { x: e.offsetX };
            
            $(document).mousemove((e) => {
                if (flag === true) {
                    let _left = e.clientX - father.offset().left - mousePos.x;
                    let _distance = Math.max(0, Math.min(_left, this.width));
                    let _ratio = _distance / this.width;
                    let _value = _ratio * (this.max - this.min) + this.min;
                    this.setValue(_value);
                    this.handler(_value);
                }
            });
        });
        
        $(document).mouseup(() => {
            flag = false;
        });
    }
}


//按钮 
class Btns {
    constructor(selector, handlers) {
        this.$el = $(selector); //元素
        this.bindEvents(handlers);
    }
    bindEvents(handlers) { //绑定事件
        for (const event in handlers) {
            //使用值的时候保证键值对在对象中是存在的
            if (handlers.hasOwnProperty(event)) {
                this.$el.on(event, handlers[event]);
            }
        }
    }
}
PlayerObj = new Player();
