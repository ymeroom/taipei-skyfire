/**
 * spots-data.js - 7 大核心日出/日落攝影機位
 */

const TAIPEI_SPOTS = [
  // ============ 日落機位 (Sunset) ============
  {
    id: 'dadaocheng',
    name: '大稻埕',
    category: 'sunset',
    lat: 25.057045046459375,
    lng: 121.50771810454582,
    elevation: 5,
    difficulty: '極易',
    recommendedFocal: '16-35mm / 70-200mm',
    bestAzimuth: '280° - 305°',
    tags: ['河岸', '船隻', '夕陽'],
    description: '經典水岸夕陽機位，淡水河與都市天際線交織。',
    photoTips: '利用水面反射火燒雲，尋找船隻作為前景。',
    traffic: '近捷運北門站或雙連站。'
  },
  {
    id: 'maokong',
    name: '貓空',
    category: 'sunset',
    lat: 24.98421427814147,
    lng: 121.58655991120213,
    elevation: 280,
    difficulty: '容易',
    recommendedFocal: '24-70mm',
    bestAzimuth: '280° - 315°',
    tags: ['山景', '茶園', '纜車'],
    description: '俯瞰台北盆地，結合茶園與遠處觀音山的日落景致。',
    photoTips: '可搭配纜車或茶園階梯作為視覺引導線。',
    traffic: '搭乘貓空纜車至貓空站或公車抵達。'
  },
  {
    id: 'tamsui',
    name: '淡水漁人碼頭',
    category: 'sunset',
    lat: 25.18325188330396,
    lng: 121.41209767613158,
    elevation: 5,
    difficulty: '極易',
    recommendedFocal: '24-105mm',
    bestAzimuth: '250° - 290°',
    tags: ['情人橋', '海景', '夕陽'],
    description: '北台灣最著名夕陽觀賞地，情人橋與出海口絕景。',
    photoTips: '以情人橋為主體，或捕捉停泊船隻與火燒雲的剪影。',
    traffic: '搭乘輕軌至漁人碼頭站或公車。'
  },
  {
    id: 'jiufen',
    name: '九份',
    category: 'sunset',
    lat: 25.110048954642046,
    lng: 121.83829071730524,
    elevation: 350,
    difficulty: '普通',
    recommendedFocal: '24-70mm / 70-200mm',
    bestAzimuth: '270° - 300°',
    tags: ['山城', '海景', '燈火'],
    description: '山城夕照與基隆嶼海景相映成趣，暮光時分燈火亮起極美。',
    photoTips: '傍晚時分拍攝藍調與火燒雲、山城暖色燈光的對比。',
    traffic: '搭乘客運至九份老街。'
  },
  {
    id: 'taipei-101',
    name: '101大樓',
    category: 'sunset',
    lat: 25.029049882166394,
    lng: 121.57276615548665,
    elevation: 150,
    difficulty: '普通',
    recommendedFocal: '16-35mm / 24-70mm',
    bestAzimuth: '260° - 290°',
    tags: ['地標', '城市', '夜景'],
    description: '從象山或信義區周邊拍攝101大樓與落日餘暉。',
    photoTips: '尋找合適的前景（如步道或岩石）襯托101地標與天空變化。',
    traffic: '捷運象山站步行或公車。'
  },
  
  // ============ 日出機位 (Sunrise) ============
  {
    id: 'waimushan',
    name: '外木山',
    category: 'sunrise',
    lat: 25.17594381403899,
    lng: 121.70593771941236,
    elevation: 10,
    difficulty: '容易',
    recommendedFocal: '16-35mm',
    bestAzimuth: '60° - 90°',
    tags: ['海濱', '日出', '基隆嶼'],
    description: '基隆海岸線的壯麗日出，可捕捉太陽從海平面升起的瞬間。',
    photoTips: '利用海岸礁岩作為前景，慢快門捕捉海浪軌跡與晨光。',
    traffic: '自行開車或搭乘客運至外木山海濱。'
  },
  {
    id: 'hongludi',
    name: '烘爐地',
    category: 'sunrise',
    lat: 24.972013872318254,
    lng: 121.4976771944775,
    elevation: 300,
    difficulty: '普通',
    recommendedFocal: '70-200mm',
    bestAzimuth: '60° - 90°',
    tags: ['寺廟', '大台北', '晨彩'],
    description: '從中和高處俯瞰大台北盆地，是欣賞晨彩與城市甦醒的絕佳視角。',
    photoTips: '使用長焦壓縮城市建築與遠山，或以土地公神像為前景。',
    traffic: '自行開車或騎車至烘爐地南山福德宮。'
  }
];

if (typeof window !== 'undefined') {
  window.TAIPEI_SPOTS = TAIPEI_SPOTS;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TAIPEI_SPOTS;
}
