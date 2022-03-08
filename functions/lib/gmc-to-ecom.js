const { logger } = require('firebase-functions')
const slugify = require('slugify')
const axios = require('axios')
const ecomUtils = require('@ecomplus/utils')
const FormData = require('form-data')
const SPECIFICATION_MAP = require('./specifications-map')
const htmlParser = require('node-html-parser')

const findEcomProductBySKU = async (appSdk, storeId, sku, meta = {}) => {
  console.log('findEcomProduct', sku)
  const resource = `/products.json?sku=${sku}`
  meta.findEcomProductBySKU = { resource, sku, method: 'GET ' }
  try {
    const { response: { data } } = await appSdk.apiRequest(parseInt(storeId), resource, 'GET')
    return data
  } catch (error) {
    if (error && error.response) {
      meta.findEcomProductBySKU = { resource, sku, method: 'GET ', data: { error: error.response.data, config: error.response.config } }
      logger.error({ data: error.response.data })
    }
    throw error
  }
}

const getFeedValueByKey = (key, data) => {
  return data[`g:${key}`] || data[key] || data[key.toUpperCase()] || data[`g:${key.toUpperCase()}`] || ''
}

const getSpecifications = (feedProduct) => {
  const specifications = {}
  const itemGroupID = getFeedValueByKey('item_group_id', feedProduct)

  const mappedSpecifications = itemGroupID
    ? SPECIFICATION_MAP.filter(x => x.isVariation)
    : SPECIFICATION_MAP

  for (const specification of mappedSpecifications) {
    let feedSpecifications = getFeedValueByKey(specification.gmcAttribute, feedProduct)
    feedSpecifications = Array.isArray(feedSpecifications) ? feedSpecifications : [feedSpecifications]
    for (const feedSpecification of feedSpecifications) {
      if (feedSpecification) {
        const result = typeof specification.formatter === 'function'
          ? specification.formatter(feedSpecification)
          : feedSpecification
        if (Array.isArray(result)) {
          specifications[specification.attribute] = result
          continue
        }

        specifications[specification.attribute] = [
          {
            text: feedSpecification,
            value: result.toLowerCase()
          }
        ]
      }
    }
  }
  if (itemGroupID && !Object.keys(specifications).length) {
    specifications.label = [
      {
        text: getFeedValueByKey('title', feedProduct), value: getFeedValueByKey('title', feedProduct)
      }
    ]
  }
  return specifications
}

const findBrandBySlug = async (appSdk, storeId, slug) => {
  try {
    const resource = `/brands.json?slug=${slug}`
    const { response: { data } } = await appSdk.apiRequest(parseInt(storeId), resource, 'GET')
    return data
  } catch (error) {
    if (error && error.response) {
      logger.error({ data: error.response.data })
    }
    throw error
  }
}

const getBrand = async (appSdk, storeId, feedProduct) => {
  try {
    const gmcBrand = htmlParser.parse(getFeedValueByKey('brand', feedProduct) || '')
    const brandName = gmcBrand.textContent.trim()
    const brandSlug = slugify(brandName, { strict: true, replacement: '_', lower: true })
    if (brandSlug === '') {
      return
    }
    const brand = await findBrandBySlug(appSdk, storeId, brandSlug)

    if (brand && Array.isArray(brand.result) && brand.result.length) {
      const foundBrand = { _id: brand.result[0]._id, name: brand.result[0].name, slug: brand.result[0].slug }
      return foundBrand
    }

    const newBrand = {
      name: brandName,
      slug: brandSlug
    }
    await appSdk.apiRequest(parseInt(storeId), '/brands.json', 'POST', newBrand)
    return await getBrand(appSdk, storeId, feedProduct)
  } catch (error) {
    if (error && error.response) {
      logger.error({ data: error.response.data })
    }
    throw error
  }
}

const findCategoryByName = async (appSdk, storeId, categoryName) => {
  try {
    if (findCategoryByName) {
      const resource = `/categories.json?name=${categoryName}`
      const { response: { data } } = await appSdk.apiRequest(parseInt(storeId), resource, 'GET')
      return data
    }
  } catch (error) {
    if (error && error.response) {
      logger.error({ data: error.response.data })
    }
    throw error
  }
}

const getCategory = async (appSdk, storeId, feedProduct) => {
  try {
    const gmcCategory = htmlParser.parse(getFeedValueByKey('google_product_category', feedProduct) || '')
    if (gmcCategory.textContent) {
      const categoryName = gmcCategory.textContent.split('>').reverse()[0].trim()
      const categorySlug = slugify(categoryName, { strict: true, replacement: '_', lower: true })
      console.log('------------', 'getCategory', categoryName)
      const category = await findCategoryByName(appSdk, storeId, categoryName)
      if (category && Array.isArray(category.result) && category.result.length) {
        const foundCategory = { _id: category.result[0]._id, name: category.result[0].name, slug: category.result[0].slug }
        return foundCategory
      }

      const newCategory = {
        name: categoryName,
        slug: categorySlug
      }
      await appSdk.apiRequest(parseInt(storeId), '/categories.json', 'POST', newCategory)
      return await getCategory(appSdk, storeId, feedProduct)
    }
  } catch (error) {
    if (error && error.response) {
      logger.error({ data: error.response.data })
    }
    throw error
  }
}

const tryImageUpload = async (storeId, auth, originImgUrl, product) => {
  try {
    const { data: imageToUpload } = await axios.get(originImgUrl, { responseType: 'arraybuffer' })
    const form = new FormData()
    form.append('file', Buffer.from(imageToUpload), originImgUrl.replace(/.*\/([^/]+)$/, '$1'))
    const { data, status } = await axios.post(`https://apx-storage.e-com.plus/${storeId}/api/v1/upload.json`, form, {
      headers: {
        ...form.getHeaders(),
        'X-Store-ID': storeId,
        'X-My-ID': auth.myId,
        'X-Access-Token': auth.accessToken
      }
    })

    if (data.picture) {
      for (const imgSize in data.picture) {
        if (data.picture[imgSize]) {
          if (!data.picture[imgSize].url) {
            delete data.picture[imgSize]
            continue
          }
          if (data.picture[imgSize].size !== undefined) {
            delete data.picture[imgSize].size
          }
          data.picture[imgSize].alt = `${product.name} (${imgSize})`
        }
      }
      if (Object.keys(data.picture).length) {
        return {
          _id: ecomUtils.randomObjectId(),
          ...data.picture
        }
      }

      const err = new Error('Unexpected Storage API responde')
      err.response = { data, status }
      throw err
    }
  } catch (error) {
    logger.error('[PRODUCT-TO-ECOM:tryImageUpload | ERROR]', error)
  }
}

const parseProduct = async (appSdk, appData, auth, storeId, feedProduct, product = {}, meta = {}) => {
  try {
    const categories = await getCategory(appSdk, storeId, feedProduct)
    const condition = getFeedValueByKey('condition', feedProduct)
    const newProductData = {
      sku: (getFeedValueByKey('sku', feedProduct) || getFeedValueByKey('id', feedProduct) || getFeedValueByKey('ID', feedProduct)).toString(),
      name: getFeedValueByKey('title', feedProduct),
      subtitle: getFeedValueByKey('subtitle', feedProduct),
      meta_title: getFeedValueByKey('title', feedProduct),
      meta_description: (getFeedValueByKey('description', feedProduct) || '').slice(0, 1000),
      keywords: htmlParser.parse(getFeedValueByKey('google_product_category', feedProduct) || '').textContent.split('>').map(x => x.trim().substring(0, 49)),
      base_price: Number(getFeedValueByKey('price', feedProduct).replace(/[a-z A-Z]/g, '').trim()),
      price: Number(getFeedValueByKey('sale_price', feedProduct).replace(/[a-z A-Z]/g, '').trim()),
      quantity: 0, // get on availability
      body_html: getFeedValueByKey('description', feedProduct),
      weight: {
        value: Number(getFeedValueByKey('shipping_weight', feedProduct).split(' ')[0].replace(',', '.')),
        unit: getFeedValueByKey('shipping_weight', feedProduct).split(' ')[1]
      },
      pictures: [],
      variations: [],
      categories: categories ? [categories] : [],
      specifications: getSpecifications(feedProduct)
    }

    const brands = await getBrand(appSdk, storeId, feedProduct) ? [await getBrand(appSdk, storeId, feedProduct)] : undefined
    if (brands) {
      newProductData.brands = brands
    }

    const slug = slugify(getFeedValueByKey('title', feedProduct), { strict: true, replacement: '_', lower: true })
    if (slug) {
      newProductData.slug = slug
    }

    const gtin = getFeedValueByKey('gtin', feedProduct)
    if (!newProductData.price) {
      newProductData.price = newProductData.base_price
    }
    if (gtin) {
      newProductData.gtin = [gtin.toString()]
    }
    if (condition) {
      newProductData.condition = condition
    }

    let quantity = 0
    if (getFeedValueByKey('availability', feedProduct).toLowerCase() === 'in stock') {
      quantity = appData.default_quantity || 9999
    }

    product.quantity = quantity

    product = Object.assign(product, newProductData)

    delete product._id
    console.log('[PARSED PRODUCT]', product)
    logger.log(`[PRODUCT-TO-ECOM:parseProduct | SUCCESS] - ${storeId}`, JSON.stringify(product))
    return product
  } catch (error) {
    logger.error('[PRODUCT-TO-ECOM:parseProduct | ERROR]', error)
    if (error && error.response) {
      meta.parseProductError = { data: error.response.data || '', config: error.response.config || '' }
      logger.error({ data: error.response.data })
      throw error
    }
    meta.parseProductError = { error: error.toString(), stack: error.stack }
    throw (error)
  }
}

const parseVariations = async (appSdk, appData, auth, storeId, feedVariation, variation = {}) => {
  const variationKeys = [
    'quantity',
    'sku',
    'name',
    'base_price',
    'price',
    'weight',
    'specifications'
  ]

  const parsedProduct = await parseProduct(appSdk, appData, auth, storeId, feedVariation, variation)

  const parsedVariation = {}
  for (const key of Object.keys(parsedProduct)) {
    if (variationKeys.includes(key)) {
      parsedVariation[key] = parsedProduct[key]
    }
  }

  parsedVariation._id = variation._id || ecomUtils.randomObjectId()

  return parsedVariation
}

const saveEcomProduct = async (appSdk, appData, storeId, feedProduct, variations, isVariation, meta = {}) => {
  try {
    const auth = await appSdk.getAuth(parseInt(storeId, 10))
    const sku = (getFeedValueByKey('sku', feedProduct) || getFeedValueByKey('id', feedProduct)).toString()
    const { result } = await findEcomProductBySKU(appSdk, storeId, sku, meta)
    const product = result.length > 0 ? result[0] : {}
    const { _id } = product
    const resource = _id ? `/products/${_id}.json` : '/products.json'
    const method = _id ? 'PATCH' : 'POST'
    const parsedProduct = await parseProduct(appSdk, appData, auth, storeId, feedProduct, product, meta)
    let ecomResponse = {}

    if (appData.update_product || method === 'POST') {
      const ecomRequest = { resource, method, parsedProduct: JSON.stringify(parsedProduct || '') }
      meta.ecomRequest = ecomRequest
      const { response } = await appSdk.apiRequest(parseInt(storeId), resource, method, parsedProduct)
      ecomResponse = response.data || { _id }
      if (isVariation) {
        const { result: savedProduct } = await findEcomProductBySKU(appSdk, storeId, sku)
        console.log('-----------------------savedProduct', savedProduct)
        await saveEcomVariations(appSdk, appData, storeId, variations, savedProduct[0])
      }
    }

    return ecomResponse
  } catch (error) {
    if (error && error.response) {
      meta.responseError = { data: error.response.data || '', config: error.response.config || '' }
      logger.error({ data: error.response.data })
    }
    meta.responseError = { error: error.toString() }
    throw error
  }
}

const saveEcomVariations = async (appSdk, appData, storeId, variations, product) => {
  try {
    const auth = await appSdk.getAuth(parseInt(storeId, 10))
    const parsedVariations = []
    for (const variation of variations) {
      const sku = (getFeedValueByKey('sku', variations) || getFeedValueByKey('id', variations)).toString()
      const variationFound = (product && product.variations && product.variations
        .find(x => (x.sku || '').toString() === sku.toString())) || {}
      const parsedVariation = await parseVariations(appSdk, appData, auth, storeId, variation, variationFound)
      parsedVariations.push(parsedVariation)
    }

    console.log('quebra aqui ------', product)

    await appSdk.apiRequest(parseInt(storeId), `/products/${product._id}.json`, 'PATCH', { variations: parsedVariations })
  } catch (error) {
    if (error && error.response) {
      logger.error({ data: error.response.data })
    }
    throw error
  }
}

const saveEcomImages = async (appSdk, storeId, productId, imageLinks) => {
  try {
    logger.info('saveEcomImages: start try to save image ', { storeId, productId, imageLinks })
    const auth = await appSdk.getAuth(parseInt(storeId, 10))
    const resource = `products/${productId}.json`
    const { response: product } = await appSdk.apiRequest(parseInt(storeId), resource, 'GET')
    const pictures = []
    for (const imageLink of imageLinks) {
      try {
        const newPicture = await tryImageUpload(storeId, auth, imageLink, product)
        pictures.push(newPicture)
      } catch (error) {
        if (error && error.response) {
          logger.error('saveEcomImages: error to save image ', { data: error.response.data })
        }
        logger.error('saveEcomImages: error to save image ', { error })
      }
    }
    await appSdk.apiRequest(parseInt(storeId), resource, 'PATCH', { pictures })
  } catch (error) {
    if (error && error.response) {
      logger.error({ data: error.response.data })
    }
    throw error
  }
}

module.exports = {
  parseProduct,
  tryImageUpload,
  saveEcomProduct,
  saveEcomVariations,
  getSpecifications,
  saveEcomImages
}
